/**
 * Redeeming an invitation — `/register?token=…` and `/recover?token=…`.
 *
 * The load-bearing assertion in this file is the second one: **the raw token leaves the URL before
 * anything that can await**. Everything else on the screen is ordinary UI, but that ordering is a
 * security property, it is invisible in a screenshot, and the only way to break it is a change that
 * looks like a tidy-up — moving the read into `useState`, awaiting the redemption first, adding a
 * `startTransition`. So it is asserted three ways: the address bar is clean while the exchange is
 * still in flight, the token never appears in the rendered document, and it appears exactly once in
 * exactly one request body.
 *
 * The rest of the file covers the states a real invitation actually reaches — expired, revoked,
 * already used, opened without a token at all — because each of them is a link a person will click
 * and each needs an answer better than a blank panel.
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const addPasskey = vi.fn()

vi.mock('../../src/auth/client.ts', () => ({
  authClient: {
    signIn: { passkey: () => Promise.resolve({ error: null }) },
    signOut: () => Promise.resolve({ error: null }),
    passkey: {
      addPasskey: (options: unknown) => addPasskey(options),
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}))

import { InvitationScreen } from '../../src/screens/InvitationScreen.tsx'
import {
  apiError,
  expectEveryControlIsNamed,
  installNetwork,
  json,
  meRoute,
  renderScreen,
  signedOutRoute,
} from './harness.tsx'

const TOKEN = 'inv_5f9c1c0a8e2b4d7fa1c3e6b0d4728915'
const REDEEM = 'POST /api/auth/aat/invitation/redeem'

beforeEach(() => {
  addPasskey.mockReset()
  addPasskey.mockResolvedValue({ error: null })
})

describe('invitation screen — the token', () => {
  it('removes the token from the URL before the exchange can even resolve', async () => {
    // The redemption never settles, so the only thing that could have cleaned the URL is the
    // synchronous scrub inside `takeInvitationToken`.
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => new Promise<Response>(() => {}),
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('招待を確認しています'))
    expect(window.location.search).toBe('')
    expect(window.location.pathname).toBe('/register')
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('keeps every other query parameter while deleting only the token', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => new Promise<Response>(() => {}),
    })

    renderScreen(<InvitationScreen mode="register" />, {
      path: `/register?lang=ja&token=${TOKEN}&from=mail`,
    })

    await waitFor(() => expect(window.location.search).not.toContain('token'))
    const search = new URLSearchParams(window.location.search)
    expect(search.get('lang')).toBe('ja')
    expect(search.get('from')).toBe('mail')
    expect(search.get('token')).toBeNull()
  })

  it('sends the token exactly once, in one request body, and nowhere else', async () => {
    const network = installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => json({ registrationContext: 'ctx_abc', displayName: '新しい研究者' }),
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })
    await screen.findByRole('button', { name: 'パスキーを作成' })

    const carrying = network.requests.filter(
      (request) => request.url.includes(TOKEN) || (request.body ?? '').includes(TOKEN),
    )
    expect(carrying).toHaveLength(1)
    expect(carrying[0]?.url).toBe('/api/auth/aat/invitation/redeem')
    expect(carrying[0]?.method).toBe('POST')
    expect(JSON.parse(carrying[0]?.body ?? '{}')).toEqual({ token: TOKEN })
  })

  it('leaves a clean URL behind even when the invitation is refused', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => apiError(410, 'INVITE_EXPIRED', 'この招待リンクは有効期限が切れています。'),
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('有効期限が切れています')
    // A screenshot of the failure, or a Back press, carries no secret.
    expect(window.location.search).toBe('')
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })
})

describe('invitation screen — states', () => {
  it('shows who the invitation is for once the server says', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => json({ registrationContext: 'ctx_abc', displayName: '田中', role: 'Researcher' }),
    })

    const { container } = renderScreen(<InvitationScreen mode="register" />, {
      path: `/register?token=${TOKEN}`,
    })

    // Presented as a real row header/value pair, so it is readable out of visual order.
    expect(await screen.findByRole('rowheader', { name: '表示名' })).toBeDefined()
    expect(screen.getByText('田中')).toBeDefined()
    expect(screen.getByRole('rowheader', { name: '権限' })).toBeDefined()
    expectEveryControlIsNamed(container)
  })

  it('completes the flow without the courtesy fields', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => json({ registrationContext: 'ctx_abc' }),
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })

    expect(await screen.findByRole('button', { name: 'パスキーを作成' })).toBeDefined()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('explains a link opened with no token, and does not call the server', async () => {
    const network = installNetwork({ 'GET /api/v1/me': signedOutRoute })

    renderScreen(<InvitationScreen mode="register" />, { path: '/register' })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('トークンが見つかりません')
    expect(alert.textContent).toContain('リンクは一度しか使えない')
    expect(network.requestsTo('/api/auth/aat/invitation/redeem')).toHaveLength(0)
    // Still not a dead end.
    expect(screen.getByRole('link', { name: '解析画面' }).getAttribute('href')).toBe('/')
  })

  it('uses the recovery wording on /recover', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })

    renderScreen(<InvitationScreen mode="recover" />, { path: '/recover' })

    expect(await screen.findByRole('heading', { name: 'パスキーの再登録', level: 1 })).toBeDefined()
    expect((await screen.findByRole('alert')).textContent).toContain('再登録リンク')
  })
})

describe('invitation screen — the ceremony', () => {
  it('registers, re-probes the session and leaves for the analyzer', async () => {
    let signedIn = false
    const network = installNetwork({
      'GET /api/v1/me': (request) => (signedIn ? meRoute()(request) : signedOutRoute(request)),
      [REDEEM]: () => json({ registrationContext: 'ctx_abc' }),
    })
    addPasskey.mockImplementation(() => {
      signedIn = true
      return Promise.resolve({ error: null })
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーを作成' }))

    // The registration context — not the token — is what authorises the ceremony.
    await waitFor(() => expect(addPasskey).toHaveBeenCalledWith({ context: 'ctx_abc' }))
    await waitFor(() => expect(network.requestsTo('/api/v1/me').length).toBeGreaterThanOrEqual(2))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
  })

  it('lets a cancelled ceremony be retried, because the context is not spent', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => json({ registrationContext: 'ctx_abc' }),
    })
    addPasskey.mockResolvedValueOnce({ error: { code: 'REGISTRATION_CANCELLED', message: '' } })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーを作成' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('キャンセルされました')
    // The button is back, not replaced by "ask for a new invitation".
    const again = await screen.findByRole('button', { name: 'パスキーを作成' })
    expect(again).toHaveProperty('disabled', false)

    await user.click(again)
    await waitFor(() => expect(addPasskey).toHaveBeenCalledTimes(2))
  })

  it('says so, and offers sign-in, when registration succeeded but no session opened', async () => {
    installNetwork({
      'GET /api/v1/me': signedOutRoute,
      [REDEEM]: () => json({ registrationContext: 'ctx_abc' }),
    })

    renderScreen(<InvitationScreen mode="register" />, { path: `/register?token=${TOKEN}` })
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'パスキーを作成' }))

    expect((await screen.findByText('アカウントを作成しました')).textContent).toBeDefined()
    // Scoped to the panel: the command bar also offers a sign-in link to a signed-out visitor.
    const panel = screen.getByRole('region', { name: 'アカウントの作成' })
    const link = await within(panel).findByRole('link', { name: 'サインイン' })
    expect(link.getAttribute('href')).toBe('/sign-in')
    // No redirect: the screen must not send a user to a screen that cannot help them.
    expect(window.location.pathname).toBe('/register')
  })
})
