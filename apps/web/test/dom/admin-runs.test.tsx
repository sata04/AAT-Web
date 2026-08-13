/**
 * Experiments and storage, where the interesting assertions are about restraint.
 *
 *  - **Which filters reach the server.** Run code, tag, dates and owner are query parameters;
 *    snapshot availability and poster state cannot be, because neither is a column on `runs`. The
 *    screen must not send them and must not pretend it did.
 *  - **A filter narrows only what has been inspected, and says so.** A run whose details have not
 *    been fetched is shown, marked 未取得, and counted in a notice — hiding it would make the answer
 *    to "which runs have no snapshot?" depend on how far the reader had scrolled.
 *  - **Nothing loads an object.** Opening the screen makes one listing request plus the two
 *    capability-gated summaries; per-run detail is fetched only when asked for.
 *  - **Per-user storage is labelled with who is charged.** Under the shared-workspace policy a
 *    colleague's poster render is charged to the run's owner, and a number without that label
 *    invites the wrong conclusion about who is consuming the deployment.
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

import { AdminRunsScreen } from '../../src/screens/AdminRunsScreen.tsx'
import { expectEveryControlIsNamed, installNetwork, json, meRoute, renderScreen } from './harness.tsx'

const ADMIN = meRoute({ role: 'Admin', displayName: '管理 太郎', id: 'usr_admin' })

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run_1',
    runCode: '260812',
    experimentDate: '2026-08-12',
    suffix: '',
    originalFilename: '260812_data.csv',
    memo: null,
    projectId: null,
    tags: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ownerUserId: 'usr_hanako',
    ownerDisplayName: '実験 花子',
    ...overrides,
  }
}

const STORAGE = {
  perUser: [
    {
      userId: 'usr_hanako',
      displayName: '実験 花子',
      role: 'Researcher',
      bytesUsed: 512 * 1024 * 1024,
      bytesReserved: 1024,
      bytesLimit: 1024 * 1024 * 1024,
      objectCount: 8,
    },
  ],
  totals: { objects: 8, bytes: 512 * 1024 * 1024, runs: 1, revisions: 2 },
}

const REVISIONS = {
  revisions: [
    {
      id: 'rev_1',
      runId: 'run_1',
      revisionNumber: 1,
      sourceSha256: 'a',
      configHash: 'b',
      engineVersion: '1.0.0',
      appVersion: '1.0.0',
      snapshotFormatVersion: 1,
      hasSnapshot: true,
      notes: null,
      createdAt: '2026-08-12T00:00:00.000Z',
    },
  ],
}

const BASE = {
  'GET /api/v1/me': ADMIN,
  'GET /api/v1/admin/users': () => json({ users: [], nextCursor: null }),
  'GET /api/v1/admin/storage': () => json(STORAGE),
  'GET /api/v1/workspace/runs': () => json({ runs: [run()], nextCursor: null }),
  'GET /api/v1/runs/:runId/revisions': () => json(REVISIONS),
  'GET /api/v1/revisions/:revisionId/posters': () => json({ posters: [] }),
}

describe('admin runs — filters', () => {
  it('opens without fetching a single run detail', async () => {
    const network = installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })

    await screen.findByRole('rowheader', { name: '260812' })
    expect(network.requestsTo('/api/v1/runs/run_1/revisions')).toHaveLength(0)
    expect(network.requestsTo('/api/v1/workspace/runs')).toHaveLength(1)
  })

  it('sends the server-side filters and keeps the client-side ones to itself', async () => {
    const user = userEvent.setup()
    const network = installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })
    await screen.findByRole('rowheader', { name: '260812' })

    await user.type(screen.getByLabelText(/実験コード・ファイル名/), '2608')
    await user.selectOptions(screen.getByLabelText(/スナップショット/), 'no')
    await user.click(screen.getByRole('button', { name: '絞り込む' }))

    await waitFor(() => expect(network.requestsTo('/api/v1/workspace/runs')).toHaveLength(2))
    const url = network.requestsTo('/api/v1/workspace/runs').at(-1)?.url ?? ''
    expect(url).toContain('search=2608')
    expect(url).not.toContain('snapshot')
  })

  it('keeps an uninspected run visible under a state filter, and counts it in a notice', async () => {
    const user = userEvent.setup()
    installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })
    await screen.findByRole('rowheader', { name: '260812' })

    await user.selectOptions(screen.getByLabelText(/ポスター図/), 'failed')
    await user.click(screen.getByRole('button', { name: '絞り込む' }))

    await waitFor(() => expect(screen.getByText(/1 件は詳細が未取得のため/)).toBeDefined())
    expect(screen.getByRole('rowheader', { name: '260812' })).toBeDefined()
  })

  it('fills the availability columns only when the row is inspected', async () => {
    const user = userEvent.setup()
    const network = installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })

    const row = (await screen.findByRole('rowheader', { name: '260812' })).closest('tr') as HTMLElement
    expect(within(row).getAllByText('未取得').length).toBe(2)

    await user.click(within(row).getByRole('button', { name: /詳細を取得/ }))
    await waitFor(() => expect(within(row).getByText('あり')).toBeDefined())
    expect(within(row).getByText('未生成')).toBeDefined()
    expect(network.requestsTo('/api/v1/runs/run_1/revisions')).toHaveLength(1)
  })
})

describe('admin runs — storage', () => {
  it('labels per-user usage with the shared-workspace charging rule', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })

    const panel = await screen.findByRole('region', { name: '利用者ごとの保存容量' })
    expect(panel.textContent).toContain('保存容量は「実験の所有者」に計上されます')
    expect(panel.textContent).toContain('他のメンバーが所有者の実験からポスター図を生成することがあり')
    await waitFor(() => expect(within(panel).getByText('512.0 MiB')).toBeDefined())
  })

  it('states that source-backup availability cannot be answered, rather than guessing', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })
    await screen.findByRole('rowheader', { name: '260812' })

    expect(screen.getByText(/元CSVのバックアップの有無は表示できません/)).toBeDefined()
  })

  it('reports the totals and says what the API cannot break down', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })

    const panel = await screen.findByRole('region', { name: '保存容量の合計' })
    await waitFor(() => expect(panel.textContent).toContain('1 件'))
    expect(panel.textContent).toContain(
      '種別（スナップショット／ポスター／元CSV）ごとの内訳を返すAPIはありません',
    )
  })

  it('says an empty deployment is empty', async () => {
    installNetwork({ ...BASE, 'GET /api/v1/workspace/runs': () => json({ runs: [], nextCursor: null }) })
    renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })

    expect(await screen.findByText('このデプロイにはまだ実験が保存されていません。')).toBeDefined()
  })

  it('gives every control an accessible name', async () => {
    installNetwork(BASE)
    const { container } = renderScreen(<AdminRunsScreen />, { path: '/admin/runs' })
    await screen.findByRole('rowheader', { name: '260812' })
    expectEveryControlIsNamed(container)
  })
})
