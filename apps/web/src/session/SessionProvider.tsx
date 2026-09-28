/**
 * Who is signed in, shared by every screen.
 *
 * Before this existed, `App` probed the session once and kept a boolean. That
 * was enough while there was one screen; it is not enough now that the analyzer,
 * the security screen and the admin console all need the same answer, and it
 * would be actively wrong for each of them to re-probe — three requests for one
 * fact, three chances to disagree, and a flicker on every navigation.
 *
 * Local analysis never depends on this probe. A missing cloud deployment is
 * quiet; a transient connection failure can recover on reconnect or an explicit
 * retry. Existing consumers keep the conservative `unavailable` gate, while
 * `unavailability` distinguishes those two reasons for recovery controls.
 *
 * Every operation has a generation: a slow startup response cannot undo a later
 * sign-in or sign-out, and an unmounted provider cannot publish a response.
 */

import type { Capability, Role } from '@aat/shared'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { authClient } from '../auth/client.ts'
import type { MeResponse } from '../cloud/gateway.ts'

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
  /** Kept separate from status so existing cloud gates remain conservative. */
  unavailability: 'transient' | 'deployment' | null
  refreshing: boolean
  /** Re-probe after authentication or an explicit connection retry. */
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const NO_CAPABILITIES: readonly Capability[] = []

const SessionContext = createContext<SessionState | null>(null)

export interface SessionProviderProps {
  children: React.ReactNode
}

type SessionSnapshot = Pick<SessionState, 'status' | 'user' | 'capabilities' | 'unavailability'>

function withoutSession(
  status: SessionStatus,
  unavailability: SessionState['unavailability'] = null,
): SessionSnapshot {
  return { status, user: null, capabilities: NO_CAPABILITIES, unavailability }
}

async function probeSession(): Promise<SessionSnapshot> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    // The shared gateway intentionally folds 404 and transport failures together.
    // Bootstrap needs the HTTP distinction to avoid making offline startup permanent.
    const response = await fetch('/api/v1/me', {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status === 404) return withoutSession('unavailable', 'deployment')
    if (response.status === 401) return withoutSession('signed-out')
    if (!response.ok) return withoutSession('unavailable', 'transient')
    const value = (await response.json()) as MeResponse
    return {
      status: 'signed-in',
      user: value.user,
      capabilities: value.capabilities,
      unavailability: null,
    }
  } catch {
    return withoutSession('unavailable', 'transient')
  } finally {
    clearTimeout(timeout)
  }
}

export function SessionProvider(props: SessionProviderProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => withoutSession('loading'))
  const [refreshing, setRefreshing] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const logout = useRef<Promise<void> | null>(null)
  const failure = useRef<SessionState['unavailability']>(null)

  const refresh = useCallback(async () => {
    if (!mounted.current) return
    const request = ++generation.current
    pending.current = true
    setRefreshing(true)
    // A sign-out response can expire a cookie set by a subsequent sign-in.
    // Probe only after it settles, so we publish the actual remaining session.
    // A failed best-effort logout also releases this gate for later sign-ins.
    if (logout.current !== null) await logout.current
    if (!mounted.current || request !== generation.current) return
    const next = await probeSession()
    if (!mounted.current || request !== generation.current) return
    pending.current = false
    failure.current = next.unavailability
    setSnapshot(next)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const retry = () => {
      if (failure.current === 'transient' && !pending.current) void refresh()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry()
    }
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      mounted.current = false
      generation.current += 1
      window.removeEventListener('online', retry)
      window.removeEventListener('focus', retry)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  const signOut = useCallback(async () => {
    if (!mounted.current) return
    if (logout.current !== null) return logout.current
    // Clear this tab immediately, even if the server cannot be reached. Neither
    // an old probe nor a reconnect event may resurrect it during sign-out.
    generation.current += 1
    pending.current = false
    failure.current = null
    setSnapshot(withoutSession('signed-out'))
    setRefreshing(false)
    const operation = authClient.signOut().then(
      () => {},
      () => {},
    )
    logout.current = operation
    await operation
    logout.current = null
  }, [])

  const value = useMemo<SessionState>(
    () => ({ ...snapshot, refreshing, refresh, signOut }),
    [snapshot, refreshing, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>
}

export function useSession(): SessionState {
  const session = useContext(SessionContext)
  if (session === null) throw new Error('useSession は SessionProvider の内側でのみ使用できます。')
  return session
}
