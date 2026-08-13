/**
 * A hand-rolled History API router.
 *
 * There is no `react-router` here, and that is a decision rather than an
 * omission. The route set is small, static and fully known at build time — an
 * analyzer, three authentication screens, a run gallery and a fixed admin
 * console — so none of the machinery a general router exists for (nested route
 * objects, loaders, lazy segment matching, data revalidation) buys anything.
 * `docs/supply-chain.md` asks every dependency to earn itself, and roughly a
 * hundred lines is a poor trade against ~20 KB of shipped JavaScript plus a
 * policy review. The deployment already does the only server-side work a
 * client-side router needs: `wrangler.jsonc` sets
 * `not_found_handling: "single-page-application"`, and the PWA's
 * `navigateFallback` serves the shell for arbitrary paths, so a deep link to
 * `/runs/01J…` or `/register?token=…` reaches this module without a rewrite
 * rule anywhere.
 *
 * Two properties are non-negotiable and are why this is not a `useState` over a
 * string:
 *
 *  - **Back and forward genuinely work.** `popstate` is subscribed, so the
 *    browser's own history is the source of truth rather than a mirror of it.
 *  - **Links are real links.** `Link` renders an `<a href>`, intercepts only
 *    plain left-clicks on same-origin targets, and lets ctrl/cmd/shift/middle
 *    clicks fall through to the browser. A button that navigates cannot be
 *    opened in a new tab, is not announced as a link, and has no status-bar
 *    preview — all three matter more here than the interception does.
 *
 * `navigate` and `replaceLocation` are module functions rather than context
 * values so that code outside the React tree can use them. The invitation-token
 * scrub in `src/auth/invitation-token.ts` needs exactly that: it must rewrite
 * the URL synchronously, and it must tell this module, or the router's snapshot
 * would go on holding a query string the address bar no longer shows.
 */

import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

/** Every screen this application can be at. `not-found` is the answer for anything else. */
export type RouteName =
  | 'analyzer'
  | 'sign-in'
  | 'register'
  | 'recover'
  | 'security'
  | 'runs'
  | 'run'
  | 'admin'
  | 'admin-users'
  | 'admin-invitations'
  | 'admin-runs'
  | 'admin-renderer'
  | 'admin-audit'
  | 'admin-settings'
  | 'not-found'

interface RouteDefinition {
  readonly name: Exclude<RouteName, 'not-found'>
  readonly pattern: string
}

/**
 * The route table, in match order.
 *
 * Order is not load-bearing today — every pattern has a distinct segment count
 * or a distinct literal head — but the matcher walks it top to bottom, so a
 * future overlap resolves to the earlier entry rather than to whichever one the
 * engine happened to visit first.
 */
export const ROUTES: readonly RouteDefinition[] = [
  { name: 'analyzer', pattern: '/' },
  { name: 'sign-in', pattern: '/sign-in' },
  { name: 'register', pattern: '/register' },
  { name: 'recover', pattern: '/recover' },
  { name: 'security', pattern: '/security' },
  { name: 'runs', pattern: '/runs' },
  { name: 'run', pattern: '/runs/:runId' },
  { name: 'admin', pattern: '/admin' },
  { name: 'admin-users', pattern: '/admin/users' },
  { name: 'admin-invitations', pattern: '/admin/invitations' },
  { name: 'admin-runs', pattern: '/admin/runs' },
  { name: 'admin-renderer', pattern: '/admin/renderer' },
  { name: 'admin-audit', pattern: '/admin/audit' },
  { name: 'admin-settings', pattern: '/admin/settings' },
]

export interface RouteMatch {
  name: RouteName
  /** The pattern that matched, or the raw pathname when nothing did. */
  pattern: string
  /** The pathname with any trailing slash removed, so `/runs/` and `/runs` are one route. */
  pathname: string
  /** Decoded dynamic segments. Only `:runId` exists today. */
  params: Readonly<Record<string, string>>
  search: URLSearchParams
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Resolve a `pathname?search` string to a route.
 *
 * Exported separately from the hook because it is pure: it is the piece worth
 * testing, and it has no dependency on React or on `window`.
 */
export function matchLocation(location: string): RouteMatch {
  const queryAt = location.indexOf('?')
  const rawPath = queryAt === -1 ? location : location.slice(0, queryAt)
  const search = new URLSearchParams(queryAt === -1 ? '' : location.slice(queryAt + 1))
  const pathname = rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const actual = segmentsOf(pathname)

  for (const route of ROUTES) {
    const expected = segmentsOf(route.pattern)
    if (expected.length !== actual.length) continue

    const params: Record<string, string> = {}
    let matched = true
    for (let index = 0; index < expected.length; index += 1) {
      const wanted = expected[index] ?? ''
      const given = actual[index] ?? ''
      if (wanted.startsWith(':')) {
        params[wanted.slice(1)] = decodeURIComponent(given)
        continue
      }
      if (wanted !== given) {
        matched = false
        break
      }
    }
    if (matched) return { name: route.name, pattern: route.pattern, pathname, params, search }
  }

  return { name: 'not-found', pattern: pathname, pathname, params: {}, search }
}

/**
 * Dispatched after a programmatic navigation.
 *
 * `pushState` and `replaceState` deliberately do not fire `popstate` — that
 * event means "the user moved through history" — so this is the other half of
 * the subscription.
 */
const LOCATION_EVENT = 'aat:locationchange'

function readLocation(): string {
  return `${window.location.pathname}${window.location.search}`
}

function subscribeToLocation(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(LOCATION_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(LOCATION_EVENT, onChange)
  }
}

export interface NavigateOptions {
  /** Replace the current entry instead of pushing a new one. */
  replace?: boolean | undefined
}

/**
 * Navigate to a same-origin path.
 *
 * A cross-origin target is handed to the browser rather than swallowed: this
 * function is also what `Link` calls, and silently doing nothing for an external
 * URL would be a trap.
 */
export function navigate(to: string, options: NavigateOptions = {}): void {
  const target = new URL(to, window.location.href)
  if (target.origin !== window.location.origin) {
    window.location.assign(target.href)
    return
  }
  const next = `${target.pathname}${target.search}${target.hash}`
  if (options.replace === true) {
    window.history.replaceState(null, '', next)
  } else {
    window.history.pushState(null, '', next)
  }
  window.dispatchEvent(new Event(LOCATION_EVENT))
}

/**
 * Rewrite the current URL without adding a history entry.
 *
 * Used for the invitation-token scrub, where pushing an entry would leave the
 * token one Back press away in the address bar — the opposite of the point.
 */
export function replaceLocation(to: string): void {
  navigate(to, { replace: true })
}

const RouteContext = createContext<RouteMatch | null>(null)

export interface RouterProviderProps {
  children: React.ReactNode
}

export function RouterProvider(props: RouterProviderProps): React.JSX.Element {
  // The snapshot is a plain string, so it compares by value and React re-renders
  // exactly when the URL changes — no cached object to keep referentially stable.
  const location = useSyncExternalStore(subscribeToLocation, readLocation)
  const match = useMemo(() => matchLocation(location), [location])
  return <RouteContext.Provider value={match}>{props.children}</RouteContext.Provider>
}

export function useRoute(): RouteMatch {
  const match = useContext(RouteContext)
  if (match === null) throw new Error('useRoute は RouterProvider の内側でのみ使用できます。')
  return match
}

/** The navigate function. Module-scoped, so its identity never changes between renders. */
export function useNavigate(): (to: string, options?: NavigateOptions) => void {
  return navigate
}

export interface LinkProps {
  to: string
  children: React.ReactNode
  className?: string | undefined
  /** Marks this as the screen currently shown. Rendered as `aria-current="page"`. */
  current?: boolean | undefined
  /** For links whose text alone is not descriptive out of context. */
  label?: string | undefined
  replace?: boolean | undefined
}

export function Link(props: LinkProps): React.JSX.Element {
  return (
    <a
      href={props.to}
      className={props.className}
      aria-current={props.current === true ? 'page' : undefined}
      aria-label={props.label}
      onClick={(event) => {
        // Everything below is a reason to let the browser do its own thing:
        // a modified click means "open elsewhere", a non-primary button means
        // "new tab", and a cross-origin href is not ours to intercept.
        if (event.defaultPrevented) return
        if (event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (new URL(props.to, window.location.href).origin !== window.location.origin) return
        event.preventDefault()
        navigate(props.to, { replace: props.replace === true })
      }}
    >
      {props.children}
    </a>
  )
}
