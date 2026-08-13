/**
 * The sign-in screen.
 *
 * What is worth pinning here is everything the screen's own comment claims about itself, because
 * each claim is a decision somebody could reasonably undo by accident:
 *
 *  - there is no email field and no password field, and there never will be,
 *  - the one button is focused on arrival, so the screen is usable with one keypress,
 *  - a browser that cannot do WebAuthn is told so *before* the button does anything, and is not
 *    offered a button that cannot work,
 *  - a refused ceremony produces an `alert`, not a silent no-op,
 *  - and the local analyzer is reachable from here, because a signed-out user is not a blocked
 *    user in this application.
 */

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInPasskey = vi.fn()

vi.mock('../../src/auth/client.ts', () => ({
  authClient: {
    signIn: { passkey: () => signInPasskey() },
    signOut: () => Promise.resolve({ error: null }),
    passkey: { listUserPasskeys: () => Promise.resolve({ data: [] }) },
  },
}))

import { SignInScreen } from '../../src/screens/SignInScreen.tsx'
import {
  expectEveryControlIsNamed,
  installNetwork,
  meRoute,
  renderScreen,
  signedOutRoute,
} from './harness.tsx'

beforeEach(() => {
  signInPasskey.mockReset()
})

describe('sign-in screen', () => {
  it('offers one passkey button and collects no credentials of any other kind', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    const { container } = renderScreen(<SignInScreen />, { path: '/sign-in' })

    const button = await screen.findByRole('button', { name: 'パスキーでサインイン' })
    expect(button).toBeDefined()

    // Not "there is no input with type=password" — there is no input at all. A username box added
    // to host conditional UI would pass a narrower assertion while undoing the screen's design.
    expect(container.querySelectorAll('input')).toHaveLength(0)
    expect(screen.queryByLabelText(/メール|パスワード/)).toBeNull()

    expectEveryControlIsNamed(container)
  })

  it('focuses the sign-in button on arrival', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    renderScreen(<SignInScreen />, { path: '/sign-in' })

    const button = await screen.findByRole('button', { name: 'パスキーでサインイン' })
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('reports progress while the ceremony is open and restores the button afterwards', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    let release: (value: { error: null }) => void = () => {}
    signInPasskey.mockReturnValue(
      new Promise<{ error: null }>((resolve) => {
        release = resolve
      }),
    )

    renderScreen(<SignInScreen />, { path: '/sign-in' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーでサインイン' }))

    const pending = await screen.findByRole('button', { name: '確認中…' })
    expect(pending).toHaveProperty('disabled', true)
    expect(screen.getByRole('status').textContent).toContain('端末の画面に表示される指示に従ってください')

    release({ error: null })
    await waitFor(() => expect(screen.queryByRole('button', { name: '確認中…' })).toBeNull())
  })

  it('shows a cancelled ceremony as an alert with a next step, and stays on the screen', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    signInPasskey.mockResolvedValue({
      error: { code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', message: '', status: 400 },
    })

    renderScreen(<SignInScreen />, { path: '/sign-in' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーでサインイン' }))

    const alert = await screen.findByRole('alert')
    // The one distinction WebAuthn refuses to make is named rather than guessed at.
    expect(alert.textContent).toContain('キャンセル')
    expect(alert.textContent).toContain('パスキーが見つかりませんでした')
    // Still usable: a failed attempt is not a dead end.
    expect(screen.getByRole('button', { name: 'パスキーでサインイン' })).toHaveProperty('disabled', false)
  })

  it('signs in, refreshes the session and leaves for the analyzer', async () => {
    const network = installNetwork({ 'GET /api/v1/me': signedOutRoute })
    signInPasskey.mockResolvedValue({ error: null })

    renderScreen(<SignInScreen />, { path: '/sign-in' })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーでサインイン' }))

    // The provider is the one place that knows who the new cookie belongs to, so the screen must
    // re-probe rather than assume.
    await waitFor(() => expect(network.requestsTo('/api/v1/me').length).toBeGreaterThanOrEqual(2))
    // Replaced, not pushed: Back must not bounce into a screen that immediately redirects.
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  it('redirects away immediately when a session is already open', async () => {
    installNetwork({ 'GET /api/v1/me': meRoute() })
    renderScreen(<SignInScreen />, { path: '/sign-in' })

    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(signInPasskey).not.toHaveBeenCalled()
  })

  it('refuses to offer a button when the browser cannot do WebAuthn', async () => {
    const original = Reflect.get(globalThis, 'PublicKeyCredential')
    Reflect.deleteProperty(globalThis, 'PublicKeyCredential')
    try {
      installNetwork({ 'GET /api/v1/me': signedOutRoute })
      renderScreen(<SignInScreen />, { path: '/sign-in' })

      const alert = await screen.findByRole('alert')
      expect(alert.textContent).toContain('パスキー（WebAuthn）に対応していません')
      // And it says the important part: the analysis half still works.
      expect(alert.textContent).toContain('解析機能はサインインなしでそのまま利用できます')
      expect(screen.queryByRole('button', { name: 'パスキーでサインイン' })).toBeNull()
    } finally {
      Object.defineProperty(globalThis, 'PublicKeyCredential', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })

  it('keeps a link to the analyzer, because signed out is a fully working state', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    renderScreen(<SignInScreen />, { path: '/sign-in' })

    const link = await screen.findByRole('link', { name: '解析画面' })
    expect(link.getAttribute('href')).toBe('/')
  })
})
