/**
 * Service-worker registration and the update prompt.
 *
 * An installed PWA can sit on the same bundle for months. That is the point of
 * offline support and also its main hazard: an installation that never updates
 * keeps running whatever code it cached, including a version with a fix
 * outstanding.
 *
 * So the registration is deliberately prompt-style rather than silent:
 *
 *   - a waiting worker never activates behind the user's back mid-analysis,
 *     which would swap the bundle underneath a half-finished export;
 *   - the user is *told* a new version exists and can take it immediately;
 *   - updates are polled while the app stays open, so an installation that is
 *     never restarted still learns about a release.
 *
 * Written against the plain `ServiceWorkerRegistration` API rather than
 * `workbox-window`: that package is an optional peer of `vite-plugin-pwa` and is
 * not a dependency of this app, and the whole interaction is three events. The
 * generated service worker (`registerType: 'prompt'`) listens for a
 * `{ type: 'SKIP_WAITING' }` message, which is the one contract this relies on.
 *
 * The stale-snapshot hazard is handled elsewhere, and deliberately so: both the
 * IndexedDB analysis cache and the snapshot codec carry explicit version fields,
 * and a mismatch recomputes or rejects. A service worker can serve stale
 * *assets*; it can never make old code misread a new snapshot, because the
 * format version travels inside the document.
 */

/** Where `vite-plugin-pwa`'s `generateSW` mode writes the worker. */
const SERVICE_WORKER_URL = '/sw.js'

/** Check for a new release on this cadence while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface PwaCallbacks {
  /** A new version is downloaded and waiting. Show the prompt. */
  onUpdateAvailable: (applyUpdate: () => void) => void
  /** Everything needed to work without a network is cached. */
  onOfflineReady: () => void
  /** Another client activated an update; this tab must choose when to reload. */
  onExternalUpdate: () => void
}

/**
 * Register the service worker. Returns a teardown function.
 *
 * A no-op where service workers are unavailable — an insecure origin, a browser
 * with them disabled, or a dev server that does not emit one. Offline support is
 * an enhancement; nothing in the analysis path depends on it.
 */
export function setupServiceWorker(callbacks: PwaCallbacks): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }

  let cancelled = false
  let interval: ReturnType<typeof setInterval> | null = null
  let updateRequested = false
  let controller = navigator.serviceWorker.controller
  let reloading = false
  const removeListeners: (() => void)[] = []

  /**
   * Reload once the new worker has taken over.
   *
   * Gated on `updateRequested` so that the first install — which can also fire
   * `controllerchange` if the browser claims the page — never reloads a page the
   * user is working in.
   */
  const onControllerChange = () => {
    if (cancelled) return
    const next = navigator.serviceWorker.controller
    if (updateRequested) {
      if (!reloading) {
        reloading = true
        window.location.reload()
      }
    } else if (controller !== null && next !== null && next !== controller) {
      // Activation is origin-wide. Old lazy chunks may no longer be cached,
      // but an unsolicited reload would destroy this tab's local workspace.
      callbacks.onExternalUpdate()
    }
    controller = next
  }
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

  const applyUpdate = (registration: ServiceWorkerRegistration) => () => {
    if (cancelled) return
    const waiting = registration.waiting
    if (waiting === null) {
      window.location.reload()
      return
    }
    updateRequested = true
    waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: '/' })
    .then((registration) => {
      if (cancelled) return

      // A worker left waiting by a previous visit: the user closed the tab
      // without taking the update, and it is still pending.
      if (registration.waiting !== null && navigator.serviceWorker.controller !== null) {
        callbacks.onUpdateAvailable(applyUpdate(registration))
      }

      const watchInstalling = (installing: ServiceWorker) => {
        const onStateChange = () => {
          if (cancelled) return
          if (installing.state !== 'installed') return
          if (navigator.serviceWorker.controller === null) {
            // No previous controller: this is the first install, so the app is
            // now usable offline rather than out of date.
            callbacks.onOfflineReady()
            return
          }
          callbacks.onUpdateAvailable(applyUpdate(registration))
        }
        installing.addEventListener('statechange', onStateChange)
        removeListeners.push(() => installing.removeEventListener('statechange', onStateChange))
        // The install may already be further along than 'installing' by the
        // time the listener attaches — check the current state once.
        onStateChange()
      }

      // An install already in flight from a previous page load fires no
      // `updatefound` on this registration — watch it directly.
      if (registration.installing !== null) watchInstalling(registration.installing)

      const onUpdateFound = () => {
        if (cancelled) return
        const installing = registration.installing
        if (installing === null) return
        watchInstalling(installing)
      }
      registration.addEventListener('updatefound', onUpdateFound)
      removeListeners.push(() => registration.removeEventListener('updatefound', onUpdateFound))

      interval = setInterval(() => {
        // Only worth asking when there is a network to ask over.
        if (navigator.onLine) void registration.update().catch(() => undefined)
      }, UPDATE_CHECK_INTERVAL_MS)
    })
    .catch(() => {
      // No service worker in this environment. The application is unaffected.
    })

  return () => {
    cancelled = true
    if (interval !== null) clearInterval(interval)
    for (const remove of removeListeners) remove()
    navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }
}
