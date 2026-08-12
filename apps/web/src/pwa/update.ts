/**
 * Service-worker registration and the update prompt.
 *
 * An installed PWA can sit on the same bundle for months. That is the point of
 * offline support and also its main hazard: a long-lived installation that never
 * updates keeps running whatever code it cached, including a version with a
 * known bug or a security fix outstanding, and it keeps writing whatever
 * snapshot format that version knew about.
 *
 * So the registration is deliberately `prompt`-style rather than silent:
 *
 *   - a waiting worker never activates behind the user's back mid-analysis,
 *     which would swap the bundle underneath a half-finished export;
 *   - the user is *told* an update exists and can take it immediately;
 *   - the app checks for updates periodically as well as on load, so an
 *     installation that is never restarted still learns about a new release.
 *
 * The snapshot-format hazard is handled at the cache layer rather than here:
 * both the IndexedDB analysis cache and the snapshot codec carry explicit
 * version fields, and a mismatch recomputes or rejects instead of
 * misinterpreting. A service worker can serve stale *assets*; it can never make
 * old code read a new snapshot as if it were old, because the format version is
 * inside the document.
 */

import { registerSW } from 'virtual:pwa-register'

/** Check for a new release on this cadence while the app stays open. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export interface PwaCallbacks {
  /** A new version is downloaded and waiting. Show the prompt. */
  onUpdateAvailable: (applyUpdate: () => void) => void
  /** Everything needed to work without a network is cached. */
  onOfflineReady: () => void
}

/**
 * Register the service worker.
 *
 * A no-op when service workers are unavailable (an insecure origin, a browser
 * with them disabled). Offline support is an enhancement; nothing in the
 * analysis path depends on it.
 */
export function setupServiceWorker(callbacks: PwaCallbacks): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return () => {}
  }

  let interval: ReturnType<typeof setInterval> | null = null

  const updateServiceWorker = registerSW({
    immediate: true,
    onNeedRefresh() {
      // `updateServiceWorker(true)` tells the waiting worker to take over and
      // reloads. Handing the caller the function rather than calling it is what
      // makes this a prompt and not a surprise.
      callbacks.onUpdateAvailable(() => {
        void updateServiceWorker(true)
      })
    },
    onOfflineReady() {
      callbacks.onOfflineReady()
    },
    onRegisteredSW(_url, registration) {
      if (registration === undefined) return
      interval = setInterval(() => {
        // Only worth asking when there is a network to ask over.
        if (navigator.onLine) void registration.update()
      }, UPDATE_CHECK_INTERVAL_MS)
    },
  })

  return () => {
    if (interval !== null) clearInterval(interval)
  }
}
