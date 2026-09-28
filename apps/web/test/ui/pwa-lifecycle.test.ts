import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupServiceWorker } from '../../src/pwa/update.ts'

function worker() {
  return Object.assign(new EventTarget(), { state: 'installing', postMessage: vi.fn() })
}
function harness(controlled = true) {
  const waiting = worker()
  const registration = Object.assign(new EventTarget(), {
    waiting: waiting as ReturnType<typeof worker> | null,
    installing: null as ReturnType<typeof worker> | null,
    update: vi.fn().mockResolvedValue(undefined),
  })
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: controlled ? worker() : null,
    register: vi.fn().mockResolvedValue(registration),
  })
  const reload = vi.fn()
  vi.stubGlobal('navigator', { serviceWorker, onLine: true })
  vi.stubGlobal('window', { location: { reload } })
  const callbacks = {
    onUpdateAvailable: vi.fn<(apply: () => void) => void>(),
    onOfflineReady: vi.fn(),
    onExternalUpdate: vi.fn(),
  }
  return { waiting, registration, serviceWorker, reload, callbacks }
}
let stop = () => {}
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  stop()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('service worker lifecycle', () => {
  it('offers an already-waiting update and reloads only after this client accepts it', async () => {
    const h = harness()
    stop = setupServiceWorker(h.callbacks)
    await Promise.resolve()
    const apply = h.callbacks.onUpdateAvailable.mock.calls[0]?.[0]
    expect(apply).toBeTypeOf('function')
    expect(h.reload).not.toHaveBeenCalled()
    apply?.()
    expect(h.waiting.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'SKIP_WAITING' })
    h.serviceWorker.controller = worker()
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(h.reload).toHaveBeenCalledTimes(1)
    expect(h.callbacks.onExternalUpdate).not.toHaveBeenCalled()
  })
  it('notifies a peer tab of external activation without reloading it', async () => {
    const h = harness()
    stop = setupServiceWorker(h.callbacks)
    await Promise.resolve()
    h.registration.waiting = null
    h.serviceWorker.controller = worker()
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(h.callbacks.onExternalUpdate).toHaveBeenCalledTimes(1)
    expect(h.reload).not.toHaveBeenCalled()
  })
  it('does not mistake the initial controller claim for an external update', async () => {
    const h = harness(false)
    h.registration.waiting = null
    stop = setupServiceWorker(h.callbacks)
    await Promise.resolve()
    h.serviceWorker.controller = worker()
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(h.callbacks.onExternalUpdate).not.toHaveBeenCalled()
    expect(h.reload).not.toHaveBeenCalled()
    h.serviceWorker.controller = worker()
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    expect(h.callbacks.onExternalUpdate).toHaveBeenCalledTimes(1)
  })
  it('offers a newly installed update and detaches all listeners on teardown', async () => {
    const h = harness()
    h.registration.waiting = null
    stop = setupServiceWorker(h.callbacks)
    await Promise.resolve()
    const installing = worker()
    h.registration.installing = installing
    h.registration.dispatchEvent(new Event('updatefound'))
    installing.state = 'installed'
    h.registration.waiting = installing
    installing.dispatchEvent(new Event('statechange'))
    expect(h.callbacks.onUpdateAvailable).toHaveBeenCalledTimes(1)
    stop()
    installing.dispatchEvent(new Event('statechange'))
    h.registration.dispatchEvent(new Event('updatefound'))
    h.serviceWorker.controller = worker()
    h.serviceWorker.dispatchEvent(new Event('controllerchange'))
    h.callbacks.onUpdateAvailable.mock.calls[0]?.[0]()
    expect(h.callbacks.onUpdateAvailable).toHaveBeenCalledTimes(1)
    expect(h.callbacks.onExternalUpdate).not.toHaveBeenCalled()
    expect(installing.postMessage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('keeps hourly polling failures from becoming unhandled rejections', async () => {
    const h = harness()
    h.registration.update.mockRejectedValue(new TypeError('offline'))
    stop = setupServiceWorker(h.callbacks)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(h.registration.update).toHaveBeenCalledTimes(1)
    expect(h.reload).not.toHaveBeenCalled()
  })
})
