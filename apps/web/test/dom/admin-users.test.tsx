/**
 * Account administration, where the mistakes are irreversible.
 *
 * The assertions worth having here are about *refusals and confirmations*, not about the table:
 *
 *  - A permanent deletion is reachable only by typing the account's display name, and Enter in that
 *    field does nothing. The dialog names what will be destroyed in specifics — how many objects,
 *    what happens to the audit trail — because a warning that does not name its object is a warning
 *    nobody can check.
 *  - Changing a role and disabling an account both ask first, and both name the person and the
 *    consequence. Neither is a bare "are you sure".
 *  - Nothing on this screen presents the synthetic `@aat.invalid` address as an identity. The
 *    display name is the human identity and the record id is labelled 内部ID.
 *  - A storage report that fails does not take the user list with it: the two are separate
 *    capabilities and separate requests, and an operator with one of them still gets a screen.
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

import { AdminUsersScreen } from '../../src/screens/AdminUsersScreen.tsx'
import {
  apiError,
  expectEveryControlIsNamed,
  installNetwork,
  json,
  meRoute,
  renderScreen,
  signedOutRoute,
} from './harness.tsx'

const ADMIN_ID = 'usr_admin'
const ADMIN = meRoute({ role: 'Admin', displayName: '管理 太郎', id: ADMIN_ID })

const USERS = {
  users: [
    {
      id: 'usr_admin',
      displayName: '管理 太郎',
      role: 'Admin',
      banned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'usr_hanako',
      displayName: '実験 花子',
      role: 'Researcher',
      banned: false,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'usr_taro',
      displayName: '停止 次郎',
      role: 'Viewer',
      banned: true,
      createdAt: '2026-03-01T00:00:00.000Z',
    },
  ],
  nextCursor: null,
}

const STORAGE = {
  perUser: [
    {
      userId: 'usr_hanako',
      displayName: '実験 花子',
      role: 'Researcher',
      bytesUsed: 900 * 1024 * 1024,
      bytesReserved: 0,
      bytesLimit: 1024 * 1024 * 1024,
      objectCount: 12,
    },
  ],
  totals: { objects: 12, bytes: 900 * 1024 * 1024, runs: 4, revisions: 6 },
}

const BASE = {
  'GET /api/v1/me': ADMIN,
  'GET /api/v1/admin/users': () => json(USERS),
  'GET /api/v1/admin/storage': () => json(STORAGE),
}

async function openActionsFor(name: string): Promise<HTMLElement> {
  const user = userEvent.setup()
  const row = (await screen.findByRole('rowheader', { name: new RegExp(name) })).closest('tr') as HTMLElement
  await user.click(within(row).getByRole('button', { name: new RegExp(`操作.*${name}`) }))
  return await screen.findByRole('region', { name: `${name} の操作` })
}

describe('admin users — the table', () => {
  it('shows the display name and a labelled record id, and no synthetic address', async () => {
    installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const row = (await screen.findByRole('rowheader', { name: /実験 花子/ })).closest('tr') as HTMLElement
    expect(row.textContent).toContain('内部ID usr_hanako')
    expect(document.body.textContent).not.toContain('@aat.invalid')
  })

  it('states a disabled account in words, not only in colour', async () => {
    installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const row = (await screen.findByRole('rowheader', { name: /停止 次郎/ })).closest('tr') as HTMLElement
    expect(within(row).getByText('停止')).toBeDefined()
  })

  it('distinguishes "stored nothing" from "the storage report did not reach this account"', async () => {
    installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const row = (await screen.findByRole('rowheader', { name: /停止 次郎/ })).closest('tr') as HTMLElement
    expect(row.textContent).toContain('記録なし')
  })

  it('keeps the user list when the storage report is refused', async () => {
    installNetwork({
      ...BASE,
      'GET /api/v1/admin/storage': () => apiError(403, 'FORBIDDEN', '権限がありません'),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    expect(await screen.findByRole('rowheader', { name: /実験 花子/ })).toBeDefined()
    expect((await screen.findByRole('alert')).textContent).toContain('保存容量の集計を表示できません')
  })

  it('narrows by display name without asking the server, and says so', async () => {
    const user = userEvent.setup()
    installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })
    await screen.findByRole('rowheader', { name: /実験 花子/ })

    await user.type(screen.getByLabelText(/表示名・内部IDで絞り込む/), '花子')
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: /停止 次郎/ })).toBeNull())
    expect(screen.getByText(/サーバー側の検索APIはありません/)).toBeDefined()
  })

  it('gives every control an accessible name', async () => {
    installNetwork(BASE)
    const { container } = renderScreen(<AdminUsersScreen />, { path: '/admin/users' })
    await screen.findByRole('rowheader', { name: /実験 花子/ })
    expectEveryControlIsNamed(container)
  })
})

describe('admin users — destructive confirmation', () => {
  it('will not delete until the display name is typed, and Enter does not confirm', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'DELETE /api/v1/admin/users/:userId': () => json({ ok: true, objectsDeleted: 12 }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: 'アカウントを完全に削除' }))

    const dialog = await screen.findByRole('dialog', { name: 'アカウントを完全に削除します' })
    // Specific, not generic: what is destroyed, how much of it, and what survives.
    expect(dialog.textContent).toContain('実験 花子')
    expect(dialog.textContent).toContain('内部ID usr_hanako')
    expect(dialog.textContent).toContain('12 個')
    expect(dialog.textContent).toContain('監査ログの記録は残ります')

    const confirm = within(dialog).getByRole('button', { name: '完全に削除する' })
    expect(confirm).toHaveProperty('disabled', true)

    const field = within(dialog).getByRole('textbox')
    await user.type(field, '実験 花')
    expect(confirm).toHaveProperty('disabled', true)

    // Enter in the field must not be the last thing between a moving hand and a deleted account.
    await user.type(field, '{Enter}')
    expect(network.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)

    await user.type(field, '子')
    await waitFor(() => expect(confirm).toHaveProperty('disabled', false))
    await user.click(confirm)

    await waitFor(() => {
      expect(network.requestsTo('/api/v1/admin/users/usr_hanako')).toHaveLength(1)
    })
    expect(network.requestsTo('/api/v1/admin/users/usr_hanako')[0]?.method).toBe('DELETE')
  })

  it('closes the deletion dialog on Escape, having sent nothing', async () => {
    const user = userEvent.setup()
    const network = installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: 'アカウントを完全に削除' }))
    await screen.findByRole('dialog', { name: 'アカウントを完全に削除します' })

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(network.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0)
  })

  it('confirms a role change by naming both roles, then sends only the role', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'PATCH /api/v1/admin/users/:userId': () => json({ ok: true }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.selectOptions(within(panel).getByLabelText('権限'), 'Admin')
    await user.click(within(panel).getByRole('button', { name: '権限を変更' }))

    const dialog = await screen.findByRole('dialog', { name: '権限を変更します' })
    expect(dialog.textContent).toContain('研究者 (Researcher)')
    expect(dialog.textContent).toContain('管理者 (Admin)')

    await user.click(within(dialog).getByRole('button', { name: '実行する' }))
    await waitFor(() => expect(network.requestsTo('/api/v1/admin/users/usr_hanako')).toHaveLength(1))
    const request = network.requestsTo('/api/v1/admin/users/usr_hanako')[0]
    expect(request?.method).toBe('PATCH')
    expect(JSON.parse(request?.body ?? '{}')).toEqual({ role: 'Admin' })
  })

  it('explains that disabling ends the sessions the account already has, and carries the reason', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'PATCH /api/v1/admin/users/:userId': () => json({ ok: true }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: 'アカウントを停止' }))

    const dialog = await screen.findByRole('dialog', { name: 'アカウントを停止します' })
    expect(dialog.textContent).toContain('サインイン中のセッションは次の要求で拒否')
    expect(dialog.textContent).toContain('保存された実験・スナップショット・図は削除されません')

    await user.type(within(dialog).getByRole('textbox'), '端末紛失の連絡あり')
    await user.click(within(dialog).getByRole('button', { name: '実行する' }))

    await waitFor(() => expect(network.requestsTo('/api/v1/admin/users/usr_hanako')).toHaveLength(1))
    expect(JSON.parse(network.requestsTo('/api/v1/admin/users/usr_hanako')[0]?.body ?? '{}')).toEqual({
      banned: true,
      banReason: '端末紛失の連絡あり',
    })
  })

  it('offers no self-demotion, self-ban or self-deletion, and says why', async () => {
    installNetwork(BASE)
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('管理 太郎')
    expect(panel.textContent).toContain('管理者が誰もいないデプロイになり得る')
    expect(within(panel).getByRole('button', { name: '権限を変更' })).toHaveProperty('disabled', true)
    expect(within(panel).getByRole('button', { name: 'アカウントを停止' })).toHaveProperty('disabled', true)
    expect(within(panel).getByRole('button', { name: 'アカウントを完全に削除' })).toHaveProperty(
      'disabled',
      true,
    )
  })
})

describe('admin users — the account panel', () => {
  it('loads passkeys on request and refuses to remove the last one', async () => {
    const user = userEvent.setup()
    installNetwork({
      ...BASE,
      'GET /api/v1/admin/users/:userId/passkeys': () =>
        json({
          passkeys: [
            {
              id: 'pk1',
              deviceType: 'multiDevice',
              backedUp: true,
              createdAt: '2026-02-02T00:00:00.000Z',
              lastUsedAt: '2026-08-10T09:00:00.000Z',
            },
          ],
        }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: 'パスキーを読み込む' }))

    await waitFor(() => expect(within(panel).getByText('同期あり')).toBeDefined())
    expect(within(panel).getByRole('button', { name: '削除' })).toHaveProperty('disabled', true)
    // The one thing this deployment can honestly call "last active", labelled as what it is.
    expect(panel.textContent).toContain('セッションの最終利用時刻ではありません')
  })

  it('issues a recovery URL for the account and shows it once', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'POST /api/v1/admin/invitations': () =>
        json(
          { invitation: { id: '01JREC', expiresAt: '2099-01-01T00:00:00.000Z', token: 'recovery-token' } },
          201,
        ),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: '再登録用URLを発行' }))

    const secret = await screen.findByRole('region', { name: '再登録用URLを発行しました' })
    expect((within(secret).getByLabelText('登録用URL') as HTMLInputElement).value).toBe(
      'https://aat.test/recover?token=recovery-token',
    )
    expect(JSON.parse(network.requestsTo('/api/v1/admin/invitations')[0]?.body ?? '{}')).toMatchObject({
      kind: 'recovery',
      targetUserId: 'usr_hanako',
      displayName: '実験 花子',
    })
  })

  it('sends a quota change in bytes and reports what the server stored', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'PUT /api/v1/admin/quotas/:userId': () =>
        json({
          quota: { bytesUsed: 0, bytesReserved: 0, bytesLimit: 2 * 1024 * 1024 * 1024, objectCount: 0 },
        }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    const amount = within(panel).getByLabelText('上限')
    await user.clear(amount)
    await user.type(amount, '2')
    await user.click(within(panel).getByRole('button', { name: '上限を変更' }))

    await waitFor(() => expect(network.requestsTo('/api/v1/admin/quotas/usr_hanako')).toHaveLength(1))
    expect(JSON.parse(network.requestsTo('/api/v1/admin/quotas/usr_hanako')[0]?.body ?? '{}')).toEqual({
      bytesLimit: 2 * 1024 * 1024 * 1024,
    })
    expect((await screen.findByRole('status')).textContent).toContain('2.0 GiB')
  })

  it('counts the runs of one member only when asked', async () => {
    const user = userEvent.setup()
    installNetwork({
      ...BASE,
      'GET /api/v1/workspace/runs': () => json({ runs: [{ id: 'r1' }, { id: 'r2' }], nextCursor: null }),
    })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await openActionsFor('実験 花子')
    await user.click(within(panel).getByRole('button', { name: '数える' }))
    await waitFor(() => expect(panel.textContent).toContain('2 件'))
  })
})

describe('admin users — session states', () => {
  it('sends a signed-out reader to sign in rather than showing an empty console', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await screen.findByRole('region', { name: 'この画面は表示できません' })
    expect(within(panel).getByRole('link', { name: 'サインイン' }).getAttribute('href')).toBe('/sign-in')
  })

  it('tells a non-administrator that signing in again will not help, and asks the Worker for nothing', async () => {
    const network = installNetwork({ 'GET /api/v1/me': meRoute({ role: 'Researcher' }) })
    renderScreen(<AdminUsersScreen />, { path: '/admin/users' })

    const panel = await screen.findByRole('region', { name: '権限がありません' })
    expect(panel.textContent).toContain('サインインし直しても表示できません')
    // The client gate is UX only — but it should not generate refusals for the Worker to answer.
    expect(network.requests.filter((request) => request.url.startsWith('/api/v1/admin'))).toHaveLength(0)
  })
})
