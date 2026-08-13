/**
 * The renderer screen: one real switch, and a great deal of honesty about the rest.
 *
 * The switch is the interesting part. Opening the circuit breaker stops poster generation for every
 * member of the deployment, so it is behind the typed-phrase dialog and it insists on a reason —
 * the next operator to look at this screen reads that reason, and a breaker found open with no
 * reason is indistinguishable from a misclick. Closing it is the opposite shape: lighter, but it
 * shows back the reason somebody else recorded, because re-enabling is overriding their decision.
 *
 * The rest of the screen is asserted for what it *refuses* to claim: no rate where it has only a
 * sample, no failure count it cannot compute, no container metrics it cannot read, and no
 * keep-the-container-warm control — short-lived on-demand rendering is the cost design.
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

import { BREAKER_CONFIRM_PHRASE } from '../../src/components/AdminBreakerControl.tsx'
import { AdminRendererScreen } from '../../src/screens/AdminRendererScreen.tsx'
import { expectEveryControlIsNamed, installNetwork, json, meRoute, renderScreen } from './harness.tsx'

const ADMIN = meRoute({ role: 'Admin', displayName: '管理 太郎', id: 'usr_admin' })

const AUDIT = {
  entries: [
    {
      id: '01J2',
      actorUserId: 'usr_hanako',
      action: 'poster.render',
      targetType: 'poster_figure',
      targetId: 'pf2',
      targetOwnerUserId: 'usr_admin',
      ipAddress: null,
      details: { byteSize: 2048, rendererVersion: '1.4.0' },
      createdAt: '2026-08-12T09:00:00.000Z',
    },
    {
      id: '01J1',
      actorUserId: 'usr_hanako',
      action: 'poster.retry',
      targetType: 'poster_figure',
      targetId: 'pf1',
      targetOwnerUserId: 'usr_admin',
      ipAddress: null,
      details: null,
      createdAt: '2026-08-12T08:00:00.000Z',
    },
  ],
  nextCursor: null,
}

const CLOSED = { circuitBreaker: { open: false, reason: null, updatedAt: '2026-08-12T00:00:00.000Z' } }

const BASE = {
  'GET /api/v1/me': ADMIN,
  'GET /api/v1/admin/renderer': () => json(CLOSED),
  'GET /api/v1/admin/audit': () => json(AUDIT),
  'GET /api/v1/workspace/runs': () => json({ runs: [], nextCursor: null }),
}

describe('renderer — the circuit breaker', () => {
  it('needs the phrase typed and a reason recorded before it stops the deployment', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'PUT /api/v1/admin/renderer': () =>
        json({
          circuitBreaker: {
            open: true,
            reason: 'コンテナが応答しない',
            updatedAt: '2026-08-12T11:00:00.000Z',
          },
        }),
    })

    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })
    await screen.findByText('稼働中（ブレーカー閉）')

    await user.click(screen.getByRole('button', { name: 'ポスター生成を停止する' }))
    const dialog = await screen.findByRole('dialog', { name: 'ポスター生成をデプロイ全体で停止します' })
    expect(dialog.textContent).toContain('すべての利用者について、ポスター図の生成が停止')
    expect(dialog.textContent).toContain('ローカルの解析・グラフ・Excel書き出しには影響しません')

    const confirm = within(dialog).getByRole('button', { name: '停止する' })
    expect(confirm).toHaveProperty('disabled', true)

    await user.type(within(dialog).getByLabelText(/停止の理由/), 'コンテナが応答しない')
    // Still refused: the reason is not the gate, the typed phrase is.
    expect(confirm).toHaveProperty('disabled', true)

    await user.type(within(dialog).getByLabelText(/続けるには/), BREAKER_CONFIRM_PHRASE)
    await waitFor(() => expect(confirm).toHaveProperty('disabled', false))
    await user.click(confirm)

    await waitFor(() => expect(network.requestsTo('/api/v1/admin/renderer').length).toBe(2))
    const put = network.requestsTo('/api/v1/admin/renderer').at(-1)
    expect(put?.method).toBe('PUT')
    expect(JSON.parse(put?.body ?? '{}')).toEqual({ open: true, reason: 'コンテナが応答しない' })
    await screen.findByText('停止中（ブレーカー開）')
  })

  it('shows the recorded reason back before letting it be re-enabled', async () => {
    const user = userEvent.setup()
    const network = installNetwork({
      ...BASE,
      'GET /api/v1/admin/renderer': () =>
        json({
          circuitBreaker: { open: true, reason: '費用の上限に到達', updatedAt: '2026-08-12T11:00:00.000Z' },
        }),
      'PUT /api/v1/admin/renderer': () => json(CLOSED),
    })

    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })
    await screen.findByText('停止中（ブレーカー開）')

    await user.click(screen.getByRole('button', { name: 'ポスター生成を再開する' }))
    const dialog = await screen.findByRole('dialog', { name: 'ポスター生成を再開します' })
    expect(dialog.textContent).toContain('費用の上限に到達')
    expect(dialog.textContent).toContain('コンテナの起動時間と実行時間はそのまま費用になります')

    await user.click(within(dialog).getByRole('button', { name: '再開する' }))
    await waitFor(() => {
      expect(JSON.parse(network.requestsTo('/api/v1/admin/renderer').at(-1)?.body ?? '{}')).toEqual({
        open: false,
        reason: null,
      })
    })
  })

  it('does not offer any way to keep the container warm, and says why', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })
    await screen.findByText('稼働中（ブレーカー閉）')

    const buttons = screen.getAllByRole('button').map((button) => button.textContent ?? '')
    expect(buttons.some((label) => /常時起動|ウォーム|keep.?alive/i.test(label))).toBe(false)
    expect(document.body.textContent).toContain('コンテナを常時起動させておく設定は用意していません')
  })
})

describe('renderer — what it will and will not claim', () => {
  it('reports the renderer version as the last successful render, with its timestamp', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })

    const panel = await screen.findByRole('region', { name: 'バージョン' })
    await waitFor(() => expect(panel.textContent).toContain('1.4.0'))
    expect(panel.textContent).toContain('最後に成功したレンダリング')
    expect(panel.textContent).toContain('aat-poster-v1')
  })

  it('labels the activity counts as a sample of the log, never as a rate', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })

    const panel = await screen.findByRole('region', { name: '直近の生成状況' })
    await waitFor(() => expect(panel.textContent).toContain('直近 2 件の監査ログ'))
    expect(panel.textContent).toContain('単位時間あたりの件数ではありません')
    expect(panel.textContent).toContain('再試行の件数は、失敗が起きたことの下限')
  })

  it('lists the renderer facts that have no route behind them', async () => {
    installNetwork(BASE)
    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })

    const panel = await screen.findByRole('region', { name: 'この画面に表示できない情報' })
    expect(panel.textContent).toContain('レンダリング所要時間')
    expect(panel.textContent).toContain('コンテナのサイズ・種別・インスタンス数')
  })

  it('says nothing rather than zero when no render is in the sample', async () => {
    installNetwork({ ...BASE, 'GET /api/v1/admin/audit': () => json({ entries: [], nextCursor: null }) })
    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })

    const panel = await screen.findByRole('region', { name: 'バージョン' })
    await waitFor(() =>
      expect(panel.textContent).toContain('直近の監査ログに成功したレンダリングがありません'),
    )
  })
})

describe('renderer — finding a failed figure', () => {
  it('inspects one run on request and points the retry at the run screen', async () => {
    const user = userEvent.setup()
    installNetwork({
      ...BASE,
      'GET /api/v1/workspace/runs': () =>
        json({
          runs: [
            {
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
            },
          ],
          nextCursor: null,
        }),
      'GET /api/v1/runs/:runId/revisions': () =>
        json({
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
        }),
      'GET /api/v1/revisions/:revisionId/posters': () =>
        json({
          posters: [
            {
              posterId: 'pf1',
              analysisRevisionId: 'rev_1',
              kind: 'auto',
              presetVersion: 'aat-poster-v1',
              specHash: 'h',
              status: 'failed',
              rendererVersion: null,
              failureCode: 'POSTER_RENDER_FAILED',
              attemptCount: 2,
              createdAt: '2026-08-12T01:00:00.000Z',
            },
          ],
        }),
    })

    renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })
    await user.click(await screen.findByRole('button', { name: /図の状態を確認/ }))

    await waitFor(() => expect(screen.getByText('POSTER_RENDER_FAILED')).toBeDefined())
    expect(screen.getByText('失敗')).toBeDefined()
    // Retry needs the plot spec, which is rebuilt from the snapshot — an admin console does not
    // download measurement data, so the action lives where the snapshot already is.
    expect(document.body.textContent).toContain('管理画面は測定データを読み込みません')
    expect(screen.getAllByRole('link', { name: /この実験の画面|260812/ }).length).toBeGreaterThan(0)
  })

  it('gives every control an accessible name', async () => {
    installNetwork(BASE)
    const { container } = renderScreen(<AdminRendererScreen />, { path: '/admin/renderer' })
    await screen.findByText('稼働中（ブレーカー閉）')
    expectEveryControlIsNamed(container)
  })
})
