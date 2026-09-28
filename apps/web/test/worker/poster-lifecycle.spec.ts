import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  POSTER_RENDERER_SLEEP_AFTER_MS,
  PosterRendererContainer,
} from '../../worker/container/poster-renderer.ts'

function controlledContainer(healthy: boolean, failDestroy = false) {
  let now = 1_000_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const setAlarm = vi.fn(async (_time: number) => {})
  const container = {
    running: false,
    start: vi.fn(() => {
      container.running = true
    }),
    destroy: vi.fn(async () => {
      if (failDestroy) {
        failDestroy = false
        throw new Error('temporary teardown failure')
      }
      container.running = false
    }),
    getTcpPort: () => ({
      fetch: vi.fn(async (input: Request | string) => {
        const path = new URL(typeof input === 'string' ? input : input.url).pathname
        if (path === '/health') {
          if (!healthy) now += 45_000
          return new Response(null, { status: healthy ? 200 : 503 })
        }
        now += 50_000
        return new Response('PNG')
      }),
    }),
  }
  const renderer = new PosterRendererContainer(
    { container, storage: { setAlarm } } as unknown as DurableObjectState,
    env,
  )
  return { clock, setAlarm, container, renderer, time: () => now }
}

describe('container teardown state machine', () => {
  it('arms teardown before a cold start and destroys an unhealthy container', async () => {
    const controlled = controlledContainer(false)
    try {
      const response = await controlled.renderer.fetch(
        new Request('http://renderer/render', { method: 'POST' }),
      )
      expect(response.status).toBe(429)
      expect(controlled.setAlarm.mock.invocationCallOrder[0]).toBeLessThan(
        controlled.container.start.mock.invocationCallOrder[0] ?? 0,
      )
      expect(controlled.container.destroy).toHaveBeenCalledOnce()
      expect(controlled.container.running).toBe(false)
      expect(controlled.setAlarm).toHaveBeenLastCalledWith(controlled.time() + POSTER_RENDERER_SLEEP_AFTER_MS)
    } finally {
      controlled.clock.mockRestore()
    }
  })

  it('retains an imminent alarm if startup teardown fails, and the alarm retries it', async () => {
    const controlled = controlledContainer(false, true)
    try {
      expect((await controlled.renderer.fetch(new Request('http://renderer/render'))).status).toBe(429)
      expect(controlled.container.running).toBe(true)
      expect(controlled.setAlarm).toHaveBeenLastCalledWith(controlled.time() + POSTER_RENDERER_SLEEP_AFTER_MS)
      await controlled.renderer.alarm()
      expect(controlled.container.running).toBe(false)
    } finally {
      controlled.clock.mockRestore()
    }
  })

  it('starts the idle period after a long render finishes', async () => {
    const controlled = controlledContainer(true)
    try {
      expect((await controlled.renderer.fetch(new Request('http://renderer/render'))).status).toBe(200)
      expect(controlled.setAlarm).toHaveBeenLastCalledWith(controlled.time() + POSTER_RENDERER_SLEEP_AFTER_MS)
      await controlled.renderer.alarm()
      expect(controlled.container.running).toBe(false)
    } finally {
      controlled.clock.mockRestore()
    }
  })
})
