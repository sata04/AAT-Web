// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScreenFrame } from '../../src/components/ScreenFrame.tsx'
import { SessionProvider, type SessionState, useSession } from '../../src/session/SessionProvider.tsx'

vi.mock('../../src/auth/client.ts', () => ({ authClient: { signOut: vi.fn() } }))
vi.mock('../../src/components/CommandBar.tsx', () => ({ CommandBar: () => null }))

import { authClient } from '../../src/auth/client.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function signedIn(id = 'current'): Response {
  return Response.json({ user: { id, displayName: id, role: 'Member' }, capabilities: [], quota: null })
}
let session: SessionState
function Probe() {
  session = useSession()
  // biome-ignore lint/correctness/noChildrenProp: Strict createElement typing requires ScreenFrame's children prop.
  return createElement(ScreenFrame, { title: 'Session', children: session.status })
}
const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  vi.mocked(authClient.signOut)
    .mockReset()
    .mockResolvedValue({ data: { success: true }, error: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function mount(strict = false) {
  const provider = createElement(SessionProvider, null, createElement(Probe))
  const view = render(strict ? createElement(StrictMode, null, provider) : provider)
  await act(async () => {})
  return view
}

describe('session recovery and operation ordering', () => {
  it('recovers an offline startup on online', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(signedIn())
    await mount()
    expect(session.status).toBe('unavailable')
    expect(session.unavailability).toBe('transient')
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(session.status).toBe('signed-in')
    expect(session.user?.id).toBe('current')
    expect(session.unavailability).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('retries on focus/visible, coalescing signals while a retry is pending', async () => {
    const retry = deferred<Response>()
    fetchMock.mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(retry.promise)
    await mount()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      retry.resolve(new Response(null, { status: 401 }))
    })
    expect(session.status).toBe('signed-out')
  })
  it('keeps a missing deployment distinct and exposes an explicit retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(signedIn())
    await mount()
    expect(session.unavailability).toBe('deployment')
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'クラウド接続を再確認' }))
    })
    expect(session.status).toBe('signed-in')
  })
  it('does not let a pre-login probe clear a newer session', async () => {
    const old = deferred<Response>()
    fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce(signedIn())
    await mount()
    await act(async () => {
      await session.refresh()
    })
    await act(async () => {
      old.resolve(new Response(null, { status: 401 }))
    })
    expect(session.status).toBe('signed-in')
    expect(session.user?.id).toBe('current')
  })
  it('invalidates old probes immediately when sign-out starts', async () => {
    const old = deferred<Response>()
    const logout = deferred<Awaited<ReturnType<typeof authClient.signOut>>>()
    fetchMock.mockReturnValueOnce(old.promise)
    vi.mocked(authClient.signOut).mockReturnValueOnce(logout.promise)
    await mount()
    let signingOut!: Promise<void>
    await act(async () => {
      signingOut = session.signOut()
    })
    expect(session.status).toBe('signed-out')
    await act(async () => {
      old.resolve(signedIn('stale'))
      window.dispatchEvent(new Event('online'))
    })
    expect(session.user).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      logout.resolve({ data: { success: true }, error: null })
      await signingOut
    })
    expect(session.status).toBe('signed-out')
  })
  it('waits for a delayed logout cookie expiration before probing a newer login', async () => {
    const logout = deferred<Awaited<ReturnType<typeof authClient.signOut>>>()
    let cookie: string | null = 'before'
    fetchMock.mockImplementation(async () =>
      cookie === null ? new Response(null, { status: 401 }) : signedIn(cookie),
    )
    vi.mocked(authClient.signOut).mockReturnValueOnce(logout.promise)
    await mount()
    let signingOut!: Promise<void>
    let refreshing!: Promise<void>
    await act(async () => {
      signingOut = session.signOut()
      cookie = 'new-login'
      refreshing = session.refresh()
    })
    // No probe may publish the cookie that the outstanding response can still expire.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(session.status).toBe('signed-out')
    await act(async () => {
      cookie = null
      logout.resolve({ data: { success: true }, error: null })
      await signingOut
      await refreshing
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(session.status).toBe('signed-out')
    expect(session.user).toBeNull()
    // A login after logout settlement can publish normally.
    await act(async () => {
      cookie = 'after'
      await session.refresh()
    })
    expect(session.user?.id).toBe('after')
  })
  it.each(['reject', 'error'] as const)(
    'releases the refresh gate after a best-effort sign-out failure (%s)',
    async (failure) => {
      const logout = deferred<Awaited<ReturnType<typeof authClient.signOut>>>()
      fetchMock.mockResolvedValueOnce(signedIn('before')).mockResolvedValueOnce(signedIn('after'))
      vi.mocked(authClient.signOut).mockReturnValueOnce(logout.promise)
      await mount()
      let signingOut!: Promise<void>
      await act(async () => {
        signingOut = session.signOut()
      })
      expect(session.status).toBe('signed-out')
      await act(async () => {
        if (failure === 'reject') logout.reject(new Error('offline'))
        else
          logout.resolve({
            data: null,
            error: { status: 503, statusText: 'Unavailable', message: 'offline' },
          })
        await signingOut
      })
      expect(session.status).toBe('signed-out')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(async () => {
        await session.refresh()
      })
      expect(session.user?.id).toBe('after')
    },
  )
  it('allows a newer login refresh waiting on a failed logout to publish', async () => {
    const logout = deferred<Awaited<ReturnType<typeof authClient.signOut>>>()
    fetchMock.mockResolvedValueOnce(signedIn('before')).mockResolvedValueOnce(signedIn('after'))
    vi.mocked(authClient.signOut).mockReturnValueOnce(logout.promise)
    await mount()
    let signingOut!: Promise<void>
    let refreshing!: Promise<void>
    await act(async () => {
      signingOut = session.signOut()
      refreshing = session.refresh()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      logout.reject(new Error('offline'))
      await signingOut
      await refreshing
    })
    expect(session.user?.id).toBe('after')
    expect(session.refreshing).toBe(false)
  })
  it('survives StrictMode effect replay and ignores the first setup response', async () => {
    const first = deferred<Response>()
    fetchMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(signedIn('second'))
    await mount(true)
    await act(async () => {
      first.resolve(new Response(null, { status: 401 }))
    })
    expect(session.user?.id).toBe('second')
    expect(session.refreshing).toBe(false)
  })
  it('removes recovery listeners and ignores results after unmount', async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const view = await mount()
    const before = session
    view.unmount()
    await act(async () => {
      pending.resolve(signedIn())
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('focus'))
      await session.refresh()
      await session.signOut()
    })
    expect(session).toBe(before)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(authClient.signOut).not.toHaveBeenCalled()
  })
})
