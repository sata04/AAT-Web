/**
 * Loading one endpoint into an {@link AdminResource}, with the three properties every screen needs.
 *
 * This is the only file under `src/admin/` that imports React, and it is here rather than in a
 * component because it is admin *behaviour* rather than admin presentation: which request is in
 * flight, what happens to a response that arrives after the reader navigated away, and how a panel
 * is retried are decisions this console makes the same way seven times.
 *
 * Three properties, each of which is a bug that occurred before it was written down:
 *
 *  - **A stale response never lands.** Every load carries a sequence number and only the newest one
 *    is allowed to set state. Without it, changing the audit filter twice quickly shows the first
 *    filter's rows under the second filter's controls — a log that is quietly answering a question
 *    nobody asked is worse than a log that is empty.
 *  - **An unmounted screen is not written to.** The console navigates between seven screens whose
 *    requests take longer than a click, and React 19 still warns on a setState after unmount for
 *    good reason: it is an update nobody will ever see, keeping the whole closure alive.
 *  - **`enabled: false` is a real state, not a skipped hook.** A panel whose capability the caller
 *    lacks must not fire its request at all — the Worker would refuse it, correctly, and the
 *    console would have spent a round trip to learn what `session.capabilities` already said.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CloudOutcome } from '../cloud/gateway.ts'
import { type AdminResource, LOADING, resourceOf } from './resource.ts'

export interface AdminResourceHandle<T> {
  resource: AdminResource<T>
  /** Re-run the loader. Safe to call from a button; the newest call wins. */
  reload: () => void
  /**
   * Replace the loaded value without a round trip.
   *
   * Used after a mutation whose response already contains the new state — setting a quota returns
   * the quota row, opening the breaker returns the breaker — so the screen shows what the server
   * said rather than what the client hoped, without a second request to find out.
   */
  set: (value: T) => void
}

/**
 * Load `loader()` when `enabled`, and again whenever `key` changes.
 *
 * `key` rather than a dependency array because the loaders here are closures over filter state, so
 * a dependency array would either be `[loader]` — which changes every render — or a hand-maintained
 * list that silently stops re-running when somebody adds a filter. A string key is the thing that
 * actually identifies the request, and it is what the cursor, the filter and the sort all fold into.
 */
export function useAdminResource<T>(
  loader: () => Promise<CloudOutcome<T>>,
  key: string,
  enabled = true,
): AdminResourceHandle<T> {
  const [resource, setResource] = useState<AdminResource<T>>(LOADING)
  const latest = useRef(0)
  const mounted = useRef(true)
  // The loader is a fresh closure every render; keeping it in a ref means `reload` has a stable
  // identity and an effect keyed on `key` still calls the newest one.
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const run = useCallback(() => {
    if (!enabled) return
    const sequence = latest.current + 1
    latest.current = sequence
    setResource(LOADING)
    void loaderRef.current().then((outcome) => {
      if (!mounted.current || latest.current !== sequence) return
      setResource(resourceOf(outcome))
    })
  }, [enabled])

  // `key` is the whole point of this effect and the linter cannot see it: the loader is a closure
  // over the caller's filter state, held in a ref so `reload` keeps a stable identity, so *nothing*
  // in the dependency array changes when the request changes. `key` is the caller's statement of
  // which request this is, and removing it — as the "unnecessary dependency" fix would — leaves a
  // filtered screen showing the first filter's rows forever.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` identifies the request; see above.
  useEffect(() => {
    if (!enabled) {
      setResource(LOADING)
      return
    }
    run()
  }, [key, enabled, run])

  const set = useCallback((value: T) => {
    // Bump the sequence so an in-flight load cannot overwrite the value a mutation just returned.
    latest.current += 1
    setResource({ kind: 'ready', value })
  }, [])

  return { resource, reload: run, set }
}
