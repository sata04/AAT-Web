import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ boot: vi.fn() }))
vi.mock('../../src/poster/engine/engine-core.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/poster/engine/engine-core.ts')>()
  return { ...actual, bootPosterEngine: engine.boot }
})

beforeEach(() => {
  vi.resetModules()
  engine.boot.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

it('marks a real bootstrap rejection so the renderer can discard the poisoned worker', async () => {
  const postMessage = vi.fn()
  const scope = {
    location: { href: 'https://aat.test/assets/poster-worker.js' },
    postMessage,
    onmessage: null as ((event: MessageEvent) => void) | null,
  }
  vi.stubGlobal('self', scope)
  engine.boot.mockRejectedValue(new Error('temporary fetch failure'))
  await import('../../src/poster/engine/pyodide.worker.ts')
  scope.onmessage?.(new MessageEvent('message', { data: { type: 'render', id: 1, spec: {} } }))
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'rendered',
        id: 1,
        ok: false,
        bootstrapFailed: true,
      }),
    ),
  )
  expect(engine.boot).toHaveBeenCalledTimes(1)
})

it('does not mark a post-bootstrap render error as bootstrap failure', async () => {
  const postMessage = vi.fn()
  const scope = {
    location: { href: 'https://aat.test/assets/poster-worker.js' },
    postMessage,
    onmessage: null as ((event: MessageEvent) => void) | null,
  }
  vi.stubGlobal('self', scope)
  engine.boot.mockResolvedValue({
    versions: () => ({ matplotlib: 'test', numpy: 'test', pillow: 'test' }),
    renderSpecJson: vi.fn().mockRejectedValue(new Error('bad render')),
  })
  await import('../../src/poster/engine/pyodide.worker.ts')
  scope.onmessage?.(new MessageEvent('message', { data: { type: 'render', id: 2, spec: {} } }))
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'rendered',
        id: 2,
        ok: false,
        bootstrapFailed: false,
      }),
    ),
  )
})
