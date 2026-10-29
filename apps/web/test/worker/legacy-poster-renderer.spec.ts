/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { stopRetiredPosterContainer } from '../../worker/legacy-poster-renderer.ts'

describe('retained legacy poster namespace', () => {
  it('awaits stop-only teardown for a surviving running renderer and never starts it', async () => {
    let finishStop: (() => void) | undefined
    const stopped = new Promise<void>((resolve) => {
      finishStop = resolve
    })
    const container = { running: true, destroy: vi.fn(() => stopped), start: vi.fn() }
    let finished = false
    const teardown = stopRetiredPosterContainer(container).then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(container.destroy).toHaveBeenCalledTimes(1)
    expect(container.start).not.toHaveBeenCalled()
    expect(finished).toBe(false)
    finishStop?.()
    await teardown
    expect(finished).toBe(true)
  })

  it('does nothing to an already stopped renderer', async () => {
    const container = { running: false, destroy: vi.fn(), start: vi.fn() }
    await stopRetiredPosterContainer(container)
    expect(container.destroy).not.toHaveBeenCalled()
    expect(container.start).not.toHaveBeenCalled()
  })

  it('refuses old requests without mutating retained storage', async () => {
    const stub = env.LEGACY_POSTER_RENDERER.getByName('preserved-renderer')
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('retained-state', { marker: 'keep' })
    })

    const response = await stub.fetch('https://renderer.test/render', { method: 'POST' })
    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ error: 'POSTER_RENDERER_RETIRED' })
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('retained-state')).toEqual({ marker: 'keep' })
    })
  })

  it('drains an old alarm without rescheduling or deleting retained state', async () => {
    const stub = env.LEGACY_POSTER_RENDERER.getByName('preserved-alarm')
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('retained-state', 'keep')
      await state.storage.setAlarm(Date.now() + 60_000)
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeNull()
      expect(await state.storage.get('retained-state')).toBe('keep')
    })
  })
})
