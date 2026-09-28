/**
 * The application shell: providers, a route switch, and nothing else.
 *
 * This file used to *be* the analyzer — 816 lines of dataset state, command bar
 * and status footer. That was fine while there was one screen and it stopped
 * being fine the moment there were several, so the analyzer moved to
 * `src/screens/AnalyzerScreen.tsx` unchanged and what remains here is the part
 * that is genuinely shared: which screen is showing, who is signed in, and what
 * happens when a screen throws.
 *
 * Three things wrap every screen, in this order and for these reasons:
 *
 *  - `RouterProvider` first, because the session provider must be able to render
 *    inside a known location, and because `Link` is used in the chrome that
 *    every screen draws.
 *  - `SessionProvider` second, so the answer to "who is signed in" is fetched
 *    once for the whole application rather than per screen. A negative answer is
 *    the normal local-only mode; see that file.
 *  - Each host has its own `RouteErrorBoundary`. Cloud screens reset on route
 *    changes; the analyzer stays mounted so navigation preserves local work.
 *
 * The analyzer is the fallback for nothing: it is the `/` route and it is
 * reached with no session, no network and no Worker. Every other route is a
 * cloud screen, and each of them says so rather than redirecting — a redirect
 * would make a bookmarked URL silently do something else.
 */

import { useEffect, useRef, useState } from 'react'
import { RouteErrorBoundary } from '../components/RouteErrorBoundary.tsx'
import { RouterProvider, useRoute, useRouteFocus } from '../router/Router.tsx'
import { AdminAuditScreen } from '../screens/AdminAuditScreen.tsx'
import { AdminInvitationsScreen } from '../screens/AdminInvitationsScreen.tsx'
import { AdminOverviewScreen } from '../screens/AdminOverviewScreen.tsx'
import { AdminRendererScreen } from '../screens/AdminRendererScreen.tsx'
import { AdminRunsScreen } from '../screens/AdminRunsScreen.tsx'
import { AdminSettingsScreen } from '../screens/AdminSettingsScreen.tsx'
import { AdminUsersScreen } from '../screens/AdminUsersScreen.tsx'
import { AnalyzerScreen } from '../screens/AnalyzerScreen.tsx'
import { InvitationScreen } from '../screens/InvitationScreen.tsx'
import { NotFoundScreen } from '../screens/NotFoundScreen.tsx'
// `PendingScreen` is no longer reached from here: the seven admin routes it stood in for now have
// screens. The module is left in place rather than deleted — it is the honest answer for any future
// route whose API exists before its UI does, which is exactly the situation it was written for.
import { RunDetailScreen } from '../screens/RunDetailScreen.tsx'
import { RunsScreen } from '../screens/RunsScreen.tsx'
import { SecurityScreen } from '../screens/SecurityScreen.tsx'
import { SignInScreen } from '../screens/SignInScreen.tsx'
import { SessionProvider } from '../session/SessionProvider.tsx'

function CurrentScreen(): React.JSX.Element | null {
  const route = useRoute()

  switch (route.name) {
    case 'analyzer':
      return null
    case 'sign-in':
      return <SignInScreen />
    case 'register':
      return <InvitationScreen mode="register" />
    case 'recover':
      return <InvitationScreen mode="recover" />
    case 'security':
      return <SecurityScreen />
    case 'runs':
      return <RunsScreen />
    case 'run':
      return <RunDetailScreen />
    case 'admin':
      return <AdminOverviewScreen />
    case 'admin-users':
      return <AdminUsersScreen />
    case 'admin-invitations':
      return <AdminInvitationsScreen />
    case 'admin-runs':
      return <AdminRunsScreen />
    case 'admin-renderer':
      return <AdminRendererScreen />
    case 'admin-audit':
      return <AdminAuditScreen />
    case 'admin-settings':
      return <AdminSettingsScreen />
    case 'not-found':
      return <NotFoundScreen />
  }
}

function RoutedScreen(): React.JSX.Element {
  const route = useRoute()
  const analyzerVisible = route.name === 'analyzer'
  const [analyzerVisited, setAnalyzerVisited] = useState(analyzerVisible)
  const analyzerHost = useRef<HTMLDivElement>(null)
  const screenHost = useRef<HTMLDivElement>(null)
  useRouteFocus(analyzerVisible ? analyzerHost : screenHost)

  useEffect(() => {
    if (analyzerVisible) setAnalyzerVisited(true)
  }, [analyzerVisible])

  return (
    <>
      {/* A stable host owns the in-memory workspace and its workers. Hiding it
          also removes its controls and landmarks from keyboard/AT navigation. */}
      <div ref={analyzerHost} hidden={!analyzerVisible} inert={!analyzerVisible}>
        {analyzerVisited || analyzerVisible ? (
          <RouteErrorBoundary>
            <AnalyzerScreen />
          </RouteErrorBoundary>
        ) : null}
      </div>
      <div ref={screenHost} hidden={analyzerVisible}>
        {analyzerVisible ? null : (
          <RouteErrorBoundary key={route.pathname}>
            <CurrentScreen />
          </RouteErrorBoundary>
        )}
      </div>
    </>
  )
}

export function App(): React.JSX.Element {
  return (
    <RouterProvider>
      <SessionProvider>
        <RoutedScreen />
      </SessionProvider>
    </RouterProvider>
  )
}
