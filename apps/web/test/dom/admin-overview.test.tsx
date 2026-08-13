/**
 * The console's front page, and the gate in front of the whole console.
 *
 * Two properties matter more here than anything the numbers say:
 *
 *  1. **The gate is UX, and it behaves like one.** A Researcher reaching `/admin` gets a clear
 *     refusal that says signing in again will not help — and the client, having no authority of its
 *     own, does not go and ask the Worker for administrative data it already knows it cannot have.
 *     The Worker refuses regardless; that is asserted in the workerd suite, where it belongs.
 *  2. **A panel degrades on its own.** `user:manage`, `quota:manage` and `audit:read` are separate
 *     grants and separate requests. An operator holding one of them gets that panel and a named
 *     reason for the others, not a blank space where a number was — blankness reads as zero, and
 *     "no audit entries" is a much more reassuring claim than "the audit log was not read".
 */

import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/auth/client.ts', () => ({
  authClient: {
    signIn: { passkey: () => Promise.resolve({ error: null }) },
    signOut: () => Promise.resolve({ error: null }),
    passkey: { listUserPasskeys: () => Promise.resolve({ data: [] }) },
  },
}))

import { AdminOverviewScreen } from '../../src/screens/AdminOverviewScreen.tsx'
import {
  apiError,
  expectEveryControlIsNamed,
  installNetwork,
  json,
  meRoute,
  renderScreen,
  signedOutRoute,
  unavailableRoute,
} from './harness.tsx'

const ADMIN = meRoute({ role: 'Admin', displayName: '管理 太郎', id: 'usr_admin' })

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
      id: 'usr_stop',
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
      bytesUsed: 512 * 1024 * 1024,
      bytesReserved: 0,
      bytesLimit: 1024 * 1024 * 1024,
      objectCount: 8,
    },
  ],
  // Deliberately larger than the per-user sum: the gap is a real signal, not a rounding error.
  totals: { objects: 9, bytes: 600 * 1024 * 1024, runs: 5, revisions: 7 },
}

const AUDIT = {
  entries: [
    {
      id: '01J3',
      actorUserId: 'usr_admin',
      action: 'user.ban',
      targetType: 'user',
      targetId: 'usr_stop',
      targetOwnerUserId: null,
      ipAddress: null,
      details: null,
      createdAt: '2026-08-12T10:00:00.000Z',
    },
    {
      id: '01J2',
      actorUserId: 'usr_hanako',
      action: 'poster.render',
      targetType: 'poster_figure',
      targetId: 'pf1',
      targetOwnerUserId: 'usr_admin',
      ipAddress: null,
      details: { byteSize: 1024, rendererVersion: '1.2.3' },
      createdAt: '2026-08-12T09:00:00.000Z',
    },
    {
      id: '01J1',
      actorUserId: 'usr_hanako',
      action: 'snapshot.download',
      targetType: 'analysis_revision',
      targetId: 'rev1',
      targetOwnerUserId: 'usr_hanako',
      ipAddress: null,
      details: null,
      createdAt: '2026-08-12T08:00:00.000Z',
    },
  ],
  nextCursor: null,
}

const BASE = {
  'GET /api/v1/me': ADMIN,
  'GET /api/v1/admin/users': () => json(USERS),
  'GET /api/v1/admin/storage': () => json(STORAGE),
  'GET /api/v1/admin/audit': () => json(AUDIT),
  'GET /api/v1/admin/invitations': () => json({ invitations: [], nextCursor: null }),
  'GET /api/v1/admin/renderer': () =>
    json({ circuitBreaker: { open: false, reason: null, updatedAt: null } }),
}

describe('admin overview — the gate', () => {
  it('refuses a non-administrator without asking the Worker for admin data', async () => {
    const network = installNetwork({ 'GET /api/v1/me': meRoute({ role: 'Researcher' }) })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: '権限がありません' })
    expect(panel.textContent).toContain('管理権限がありません')
    expect(panel.textContent).toContain('サインインし直しても表示できません')
    expect(within(panel).getByRole('link', { name: '解析画面へ' })).toBeDefined()
    expect(network.requests.filter((request) => request.url.startsWith('/api/v1/admin'))).toHaveLength(0)
  })

  it('offers a sign-in link when nobody is signed in', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: 'この画面は表示できません' })
    expect(within(panel).getByRole('link', { name: 'サインイン' }).getAttribute('href')).toBe('/sign-in')
  })

  it('offers no dead-end sign-in link when there is no cloud half to sign in to', async () => {
    installNetwork({ 'GET /api/v1/me': unavailableRoute })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: 'この画面は表示できません' })
    expect(panel.textContent).toContain('クラウド機能を利用できません')
    expect(within(panel).queryByRole('link', { name: 'サインイン' })).toBeNull()
    expect(within(panel).getByRole('link', { name: '解析画面へ' })).toBeDefined()
  })

  it('marks the current section in the console navigation', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const nav = await screen.findByRole('navigation', { name: '管理メニュー' })
    expect(within(nav).getByRole('link', { name: '概要' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: '利用者' }).getAttribute('aria-current')).toBeNull()
  })
})

describe('admin overview — operational facts', () => {
  it('reports membership, storage and the accounting gap', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: 'デプロイの概要' })
    await waitFor(() => expect(panel.textContent).toContain('3 人'))
    expect(panel.textContent).toContain('2 人 / 1 人')
    expect(panel.textContent).toContain('5 件')
    expect(panel.textContent).toContain('600.0 MiB')
    // The difference between cloud_objects and quota_usage is surfaced, not averaged away.
    expect(panel.textContent).toContain('88.0 MiB')
    expect(panel.textContent).toContain('確定処理が完了しなかったアップロードの兆候')
  })

  it('qualifies the poster counts with the window they were counted over', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: 'ポスター生成の状況' })
    await waitFor(() => expect(panel.textContent).toContain('直近 3 件の監査ログに含まれる件数'))
    expect(panel.textContent).toContain('期間あたりの件数ではありません')
    expect(panel.textContent).toContain('失敗したレンダリングは監査ログに記録されない')
  })

  it('shows the important entries and leaves the routine ones to the log', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: '最近の重要な操作' })
    await waitFor(() => expect(within(panel).getByText('利用者を停止')).toBeDefined())
    // A snapshot download is more frequent and less interesting; ranking by volume would bury the
    // one entry an administrator opened the console to find.
    expect(within(panel).queryByText('スナップショットを取得')).toBeNull()
    expect(within(panel).getByRole('link', { name: '監査ログをすべて見る' })).toBeDefined()
  })

  it('names the figures it cannot compute rather than omitting them', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: 'この画面に表示できない指標' })
    expect(panel.textContent).toContain('ポスター生成の失敗件数')
    expect(panel.textContent).toContain('スナップショット／ポスター／元CSVの内訳')
  })

  it('labels per-user storage with who is actually charged for it', async () => {
    installNetwork(BASE)
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const panel = await screen.findByRole('region', { name: '保存容量の多いアカウント' })
    await waitFor(() => expect(within(panel).getByText('実験 花子')).toBeDefined())
    expect(panel.textContent).toContain('ポスター図は実験の所有者に計上されます')
    // The meter is a labelled proportion, and the words next to it repeat the state.
    const meter = within(panel).getByRole('meter', { name: '実験 花子 の保存容量使用率' })
    expect(meter.getAttribute('value')).toBe('0.5')
    expect(panel.textContent).toContain('余裕あり')
  })
})

describe('admin overview — partial capabilities and failures', () => {
  it('degrades panel by panel when a capability is missing, and asks for nothing it cannot have', async () => {
    // An operator with quota:manage but neither user:manage nor audit:read: a legitimate grant, and
    // the shape that catches a screen written as though the three arrive together.
    const network = installNetwork({
      ...BASE,
      'GET /api/v1/me': meRoute({ role: 'Admin', capabilities: ['quota:manage'] }),
    })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    await screen.findByRole('region', { name: 'デプロイの概要' })
    await waitFor(() => expect(screen.getAllByText(/audit:read の権限が必要です/).length).toBeGreaterThan(0))
    expect(network.requestsTo('/api/v1/admin/audit')).toHaveLength(0)
    expect(network.requestsTo('/api/v1/admin/users')).toHaveLength(0)
    // And it does not sit there claiming to be loading something it deliberately never requested.
    expect(screen.queryByText('監査ログを読み込んでいます…')).toBeNull()
    // The panel it *can* serve is served.
    expect(network.requestsTo('/api/v1/admin/storage')).toHaveLength(1)
  })

  it('keeps the rest of the screen when one source fails, and offers a retry for an outage', async () => {
    installNetwork({ ...BASE, 'GET /api/v1/admin/audit': () => apiError(500, 'INTERNAL', '一時的な障害') })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    const overview = await screen.findByRole('region', { name: 'デプロイの概要' })
    await waitFor(() => expect(overview.textContent).toContain('3 人'))

    const alerts = await screen.findAllByRole('alert')
    expect(alerts[0]?.textContent).toContain('監査ログを表示できません')
    expect(within(alerts[0] as HTMLElement).getByRole('button', { name: '再試行' })).toBeDefined()
  })

  it('says a deployment with nothing in it has nothing, rather than showing blanks', async () => {
    installNetwork({
      ...BASE,
      'GET /api/v1/admin/users': () => json({ users: [], nextCursor: null }),
      'GET /api/v1/admin/storage': () =>
        json({ perUser: [], totals: { objects: 0, bytes: 0, runs: 0, revisions: 0 } }),
      'GET /api/v1/admin/audit': () => json({ entries: [], nextCursor: null }),
    })
    renderScreen(<AdminOverviewScreen />, { path: '/admin' })

    expect(await screen.findByText('まだ保存されたオブジェクトはありません。')).toBeDefined()
    expect(
      await screen.findByText(/直近 0 件の記録に、権限・停止・削除・招待・容量に関わる操作はありません。/),
    ).toBeDefined()
  })

  it('gives every control an accessible name', async () => {
    installNetwork(BASE)
    const { container } = renderScreen(<AdminOverviewScreen />, { path: '/admin' })
    await screen.findByRole('region', { name: 'デプロイの概要' })
    expectEveryControlIsNamed(container)
  })
})
