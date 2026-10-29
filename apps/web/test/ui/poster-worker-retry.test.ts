import { readFileSync } from 'node:fs'
import type { PosterPlotSpec } from '@aat/plot-spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SPEC = JSON.parse(
  readFileSync(new URL('../fixtures/poster-spec-aat-poster-v1-72dpi.json', import.meta.url), 'utf8'),
) as PosterPlotSpec
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  requests: { id: number }[] = []
  terminate = vi.fn()
  postMessage = vi.fn((request: { id: number }) => {
    this.requests.push(request)
  })

  constructor() {
    FakeWorker.instances.push(this)
  }

  deliver(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: message }))
  }
}

let renderer: typeof import('../../src/poster/engine/renderer.ts')

beforeEach(async () => {
  vi.resetModules()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  renderer = await import('../../src/poster/engine/renderer.ts')
})

afterEach(() => vi.unstubAllGlobals())

describe('poster Worker recovery', () => {
  it('settles all bootstrap waiters and lets the next user retry succeed on a fresh Worker', async () => {
    const settled = Promise.allSettled([renderer.renderPosterPng(SPEC), renderer.renderPosterPng(SPEC)])
    const failed = FakeWorker.instances[0]
    if (!failed) throw new Error('first render must create a Worker')
    failed.deliver({
      type: 'rendered',
      id: failed.requests[0]?.id,
      ok: false,
      bootstrapFailed: true,
      message: 'temporary asset fetch failure',
    })
    for (const result of await settled) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'POSTER_ENGINE_UNAVAILABLE' })
      }
    }
    expect(failed.terminate).toHaveBeenCalledTimes(1)
    expect(FakeWorker.instances).toHaveLength(1) // no automatic retry/download loop

    const retry = renderer.renderPosterPng(SPEC)
    const replacement = FakeWorker.instances[1]
    if (!replacement) throw new Error('user retry must create a fresh Worker')
    // A second queued boot failure/error from the old process cannot kill the replacement.
    failed.deliver({ type: 'rendered', id: failed.requests[1]?.id, ok: false, bootstrapFailed: true })
    failed.onerror?.()
    failed.onmessageerror?.()
    expect(replacement.terminate).not.toHaveBeenCalled()
    replacement.deliver({ type: 'rendered', id: replacement.requests[0]?.id, ok: true, png: PNG })
    expect(await retry).toEqual(PNG)
  })

  it.each([
    { kind: 'spec', code: 'POSTER_SPEC_INVALID' },
    { kind: 'engine', code: 'POSTER_RENDER_FAILED' },
  ])('keeps the healthy Worker after an ordinary $kind error', async ({ kind, code }) => {
    const result = renderer.renderPosterPng(SPEC)
    const rejected = expect(result).rejects.toMatchObject({ kind, code })
    const healthy = FakeWorker.instances[0]
    if (!healthy) throw new Error('first render must create a Worker')
    healthy.deliver({
      type: 'rendered',
      id: healthy.requests[0]?.id,
      ok: false,
      kind,
      code,
      bootstrapFailed: false,
    })
    await rejected
    const retry = renderer.renderPosterPng(SPEC)
    expect(FakeWorker.instances).toHaveLength(1)
    expect(healthy.terminate).not.toHaveBeenCalled()
    healthy.deliver({ type: 'rendered', id: healthy.requests[1]?.id, ok: true, png: PNG })
    expect(await retry).toEqual(PNG)
  })
})
