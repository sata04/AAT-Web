/**
 * Issuing and withdrawing the only way into this deployment.
 *
 * Four things are held still here, and none of them is "the form submits".
 *
 *  1. **The registration URL exists for exactly one render.** It is shown once, with the warning
 *     above it rather than after it, and it is gone the moment the panel is dismissed — because the
 *     server keeps only a SHA-256 and no route can produce it again.
 *  2. **The listing never carries a secret, and the screen never renders one.** The route is
 *     written not to return a token or its hash; this test feeds the screen a response that
 *     *does* carry them anyway — a Worker of a future version, a proxy that added fields, a mistake
 *     — and asserts none of it reaches the DOM. A screen that would faithfully print whatever it was
 *     sent is one route change away from putting a live credential on an operator's screen.
 *  3. **The state in the table is derived.** An invitation whose `expiresAt` has passed reads
 *     期限切れ and offers no revoke control, even though its `status` column still says `pending`.
 *  4. **Withdrawing asks first, and names who it is withdrawing.**
 */

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/auth/client.ts', () => ({
  authClient: {
    signIn: { passkey: () => Promise.resolve({ error: null }) },
    signOut: () => Promise.resolve({ error: null }),
    passkey: { listUserPasskeys: () => Promise.resolve({ data: [] }) },
  },
}))

import { AdminInvitationsScreen } from '../../src/screens/AdminInvitationsScreen.tsx'
import {
  apiError,
  expectEveryControlIsNamed,
  installNetwork,
  json,
  meRoute,
  renderScreen,
} from './harness.tsx'

const ADMIN = meRoute({ role: 'Admin', displayName: '管理 太郎', id: 'usr_admin' })

function invitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JINV0001',
    kind: 'registration',
    role: 'Researcher',
    displayName: '新入 花子',
    note: null,
    status: 'pending',
    targetUserId: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    usedAt: null,
    revokedAt: null,
    ...overrides,
  }
}

describe('admin invitations — issuing', () => {
  it('sends the intended display name, role and lifetime, and shows the URL once', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [], nextCursor: null }),
      'POST /api/v1/admin/invitations': () =>
        json(
          {
            invitation: { id: '01JNEW', expiresAt: '2099-01-01T00:00:00.000Z', token: 'plaintext-token-xyz' },
          },
          201,
        ),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    await screen.findByRole('heading', { name: '招待を発行', level: 2 })

    await user.type(screen.getByLabelText(/表示名/), '新入 花子')
    await user.selectOptions(screen.getByLabelText(/権限/), 'Viewer')
    await user.selectOptions(screen.getByLabelText(/有効期限/), '24')
    await user.click(screen.getByRole('button', { name: '招待を発行' }))

    const [request] = network
      .requestsTo('/api/v1/admin/invitations')
      .filter((entry) => entry.method === 'POST')
    expect(JSON.parse(request?.body ?? '{}')).toMatchObject({
      kind: 'registration',
      role: 'Viewer',
      displayName: '新入 花子',
      ttlHours: 24,
    })

    const panel = await screen.findByRole('region', { name: '登録用URLを発行しました' })
    // The whole URL, not a truncated one: a half-copied credential is a support ticket.
    const field = within(panel).getByLabelText('登録用URL') as HTMLInputElement
    expect(field.value).toBe('https://aat.test/register?token=plaintext-token-xyz')
    expect(field.readOnly).toBe(true)
    // The warning is an alert and it is present before anything is clicked.
    expect(within(panel).getByRole('alert').textContent).toContain('後から再表示することはできません')
  })

  it('drops the token when the panel is dismissed and never shows it again', async () => {
    const user = userEvent.setup()
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [invitation()], nextCursor: null }),
      'POST /api/v1/admin/invitations': () =>
        json(
          {
            invitation: { id: '01JNEW', expiresAt: '2099-01-01T00:00:00.000Z', token: 'plaintext-token-xyz' },
          },
          201,
        ),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    await screen.findByRole('heading', { name: '招待を発行', level: 2 })
    await user.type(screen.getByLabelText(/表示名/), '新入 花子')
    await user.click(screen.getByRole('button', { name: '招待を発行' }))

    const panel = await screen.findByRole('region', { name: '登録用URLを発行しました' })
    await user.click(within(panel).getByRole('button', { name: '閉じる（二度と表示されません）' }))

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: '登録用URLを発行しました' })).toBeNull()
    })
    expect(document.body.textContent).not.toContain('plaintext-token-xyz')
  })

  it('refuses to submit without the display name the identity model depends on', async () => {
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [], nextCursor: null }),
    })
    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    await screen.findByRole('heading', { name: '招待を発行', level: 2 })
    expect(screen.getByRole('button', { name: '招待を発行' })).toHaveProperty('disabled', true)
  })

  it('asks for the target account only for a recovery invitation', async () => {
    const user = userEvent.setup()
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [], nextCursor: null }),
    })
    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    await screen.findByRole('heading', { name: '招待を発行', level: 2 })

    expect(screen.queryByRole('textbox', { name: /対象の内部ID/ })).toBeNull()
    await user.click(screen.getByRole('radio', { name: /再登録/ }))
    expect(screen.getByRole('textbox', { name: /対象の内部ID/ })).toBeDefined()
  })
})

describe('admin invitations — the listing', () => {
  it('never renders a token, a token hash or a recovery secret, even when handed one', async () => {
    // The route deliberately returns none of these. This is the belt to that braces: the screen
    // must not be the component that would print them if a future response carried them.
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () =>
        json({
          invitations: [
            invitation({
              token: 'SECRET-PLAINTEXT-TOKEN',
              tokenHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              recoverySecret: 'SECRET-RECOVERY-VALUE',
              registrationContextHash: 'cafebabecafebabecafebabecafebabe',
            }),
          ],
          nextCursor: null,
        }),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    await screen.findByRole('rowheader', { name: '新入 花子' })

    const body = document.body.textContent ?? ''
    expect(body).not.toContain('SECRET-PLAINTEXT-TOKEN')
    expect(body).not.toContain('deadbeefdeadbeef')
    expect(body).not.toContain('SECRET-RECOVERY-VALUE')
    expect(body).not.toContain('cafebabe')
    // And it says so, so an operator does not go looking for the link in the table.
    expect(body).toContain('この一覧にトークンもそのハッシュも含まれません')
  })

  it('reads a passed expiry as 期限切れ even while the status column still says pending', async () => {
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () =>
        json({
          invitations: [invitation({ status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z' })],
          nextCursor: null,
        }),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    const row = (await screen.findByRole('rowheader', { name: '新入 花子' })).closest('tr') as HTMLElement
    expect(within(row).getByText('期限切れ')).toBeDefined()
    // No control that could only fail: the route answers INVITE_INVALID for a dead invitation.
    expect(within(row).queryByRole('button', { name: /失効させる/ })).toBeNull()
  })

  it('confirms a revocation by naming the invitee, then posts it', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [invitation()], nextCursor: null }),
      'POST /api/v1/admin/invitations/:id/revoke': () => json({ ok: true }),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    const row = (await screen.findByRole('rowheader', { name: '新入 花子' })).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: /失効させる/ }))

    const dialog = await screen.findByRole('dialog', { name: '招待を失効させます' })
    expect(dialog.textContent).toContain('新入 花子')
    expect(network.requestsTo('/api/v1/admin/invitations/01JINV0001/revoke')).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: '失効させる' }))
    await waitFor(() => {
      expect(network.requestsTo('/api/v1/admin/invitations/01JINV0001/revoke')).toHaveLength(1)
    })
  })

  it('closes the confirmation on Escape without revoking anything', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [invitation()], nextCursor: null }),
    })

    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    const row = (await screen.findByRole('rowheader', { name: '新入 花子' })).closest('tr') as HTMLElement
    await user.click(within(row).getByRole('button', { name: /失効させる/ }))
    await screen.findByRole('dialog', { name: '招待を失効させます' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(network.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
  })
})

describe('admin invitations — states', () => {
  it('says the list is empty rather than showing an empty table with no explanation', async () => {
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => json({ invitations: [], nextCursor: null }),
    })
    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    expect(await screen.findByText('発行済みの招待はありません。')).toBeDefined()
  })

  it('reports a refusal as a refusal, with no retry to press', async () => {
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => apiError(403, 'FORBIDDEN', '権限がありません'),
    })
    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('招待の一覧を表示できません')
    expect(within(alert).queryByRole('button', { name: '再試行' })).toBeNull()
  })

  it('offers a retry when the cloud simply could not be reached', async () => {
    let attempts = 0
    installNetwork({
      'GET /api/v1/me': ADMIN,
      'GET /api/v1/admin/invitations': () => {
        attempts += 1
        return apiError(500, 'INTERNAL', '一時的な障害')
      },
    })
    renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })

    const alert = await screen.findByRole('alert')
    const retry = within(alert).getByRole('button', { name: '再試行' })
    await userEvent.setup().click(retry)
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('gives every control an accessible name', async () => {
    const { container } = ((): { container: HTMLElement } => {
      installNetwork({
        'GET /api/v1/me': ADMIN,
        'GET /api/v1/admin/invitations': () => json({ invitations: [invitation()], nextCursor: null }),
      })
      return renderScreen(<AdminInvitationsScreen />, { path: '/admin/invitations' })
    })()

    await screen.findByRole('rowheader', { name: '新入 花子' })
    expectEveryControlIsNamed(container)
  })
})
