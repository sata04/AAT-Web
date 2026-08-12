/**
 * Who is signed in, shared by every screen.
 *
 * Before this existed, `App` probed the session once and kept a boolean. That
 * was enough while there was one screen; it is not enough now that the analyzer,
 * the security screen and the admin console all need the same answer, and it
 * would be actively wrong for each of them to re-probe — three requests for one
 * fact, three chances to disagree, and a flicker on every navigation.
 *
 * The behaviour that must not change: **a negative answer is the normal mode.**
 * AAT Web is local-first. No session, no network, or no cloud half deployed at
 * all are all states in which the application works completely, so none of them
 * is retried, none of them is surfaced as a fault, and none of them produces a
 * banner asking the user to sign in. The distinction the UI does draw is between
 * `signed-out` (the cloud answered, and nobody is signed in — so offering a
 * sign-in link is useful) and `unavailable` (there is nothing to sign in to — so
 * offering one would be a dead end). One probe at start-up decides which.
 *
 * `refresh` exists for the two moments the answer legitimately changes without a
 * reload: completing a passkey sign-in, and completing an invitation
 * registration. `signOut` goes through Better Auth so the session cookie is
 * cleared by the framework that set it.
 */

import type { Capability, Role } from '@aat/shared'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { authClient } from '../auth/client.ts'
import { fetchMe } from '../cloud/gateway.ts'

export type SessionStatus =
  /** The start-up probe has not answered yet. */
  | 'loading'
  | 'signed-in'
  /** The cloud is there and nobody is signed in. A normal, fully functional state. */
  | 'signed-out'
  /** No cloud half, or it cannot be reached. Also normal; also fully functional. */
  | 'unavailable'

export interface SessionUser {
  id: string
  displayName: string
  role: Role
}

export interface SessionState {
  status: SessionStatus
  user: SessionUser | null
  capabilities: readonly Capability[]
  /** Re-probe. Used after a sign-in or a registration completes. */
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const NO_CAPABILITIES: readonly Capability[] = []

const SessionContext = createContext<SessionState | null>(null)

export interface SessionProviderProps {
  children: React.ReactNode
}

export function SessionProvider(props: SessionProviderProps): React.JSX.Element {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [capabilities, setCapabilities] = useState<readonly Capability[]>(NO_CAPABILITIES)

  const refresh = useCallback(async () => {
    const outcome = await fetchMe()
    if (outcome.ok) {
      setUser(outcome.value.user)
      setCapabilities(outcome.value.capabilities)
      setStatus('signed-in')
      return
    }
    setUser(null)
    setCapabilities(NO_CAPABILITIES)
    // AUTH_REQUIRED is the cloud answering "nobody is signed in", which is a
    // different thing from the cloud not being there — and the only difference
    // that changes what the UI should offer. Every other failure, including a
    // 404 from a deployment with no Worker, is `unavailable`: not an error, not
    // retried, not shown.
    setStatus(outcome.kind === 'error' && outcome.code === 'AUTH_REQUIRED' ? 'signed-out' : 'unavailable')
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signOut = useCallback(async () => {
    // A sign-out that could not reach the server still clears this tab: leaving
    // the UI claiming a session that the user has asked to end is the worse
    // failure, and the cookie expires on its own regardless.
    await authClient.signOut().catch(() => undefined)
    setUser(null)
    setCapabilities(NO_CAPABILITIES)
    // Still `signed-out` rather than `unavailable`: the cloud answered a moment
    // ago, so a sign-in link is still the useful offer.
    setStatus('signed-out')
  }, [])

  const value = useMemo<SessionState>(
    () => ({ status, user, capabilities, refresh, signOut }),
    [status, user, capabilities, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const session = useContext(SessionContext)
  if (session === null) throw new Error('useSession は SessionProvider の内側でのみ使用できます。')
  return session
}
