/**
 * The Run Gallery.
 *
 * Three things are worth holding still here, and none of them is "the list renders".
 *
 *  1. **The order is experiment order, not upload order.** The API pages by ULID, which is upload
 *     order and exactly right for a cursor; the gallery shows experiment-date order, newest day
 *     first and suffix ascending inside a day. Those two disagree for any run analysed later than
 *     it was performed, which is most re-analyses, so a card grid that quietly rendered the API's
 *     order would look completely plausible and be wrong.
 *  2. **Which filters reach the server, and which cannot.** `search`, `tag`, date bounds and
 *     project become query parameters; `memo` cannot, because the route has no memo filter, and the
 *     screen says so. A memo filter that silently became server-side would change what an empty
 *     result *means*.
 *  3. **Nothing on this screen starts a render or blocks on the cloud.** Signed out, unavailable,
 *     erroring — each is a state with a way forward, and each one keeps the analyzer one click
 *     away, because the analyzer is the product.
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

import type { RunSummary } from '../../src/cloud/gateway.ts'
import { RunsScreen } from '../../src/screens/RunsScreen.tsx'
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

function run(overrides: Partial<RunSummary> & Pick<RunSummary, 'id' | 'runCode'>): RunSummary {
  return {
    experimentDate: null,
    suffix: '',
    originalFilename: `${overrides.runCode}_data.csv`,
    memo: null,
    projectId: null,
    tags: [],
    createdAt: '2026-08-11T02:00:00.000Z',
    updatedAt: '2026-08-11T02:00:00.000Z',
    ...overrides,
  }
}

/** The three per-card requests `loadRunFacts` makes, answered as an unanalysed run. */
const NO_FACTS = {
  'GET /api/v1/runs/:runId/revisions': () => json({ revisions: [] }),
  'GET /api/v1/revisions/:revisionId': () => json({ revision: null, config: null, metrics: null }),
  'GET /api/v1/revisions/:revisionId/posters': () => json({ posters: [] }),
}

const PROJECTS = { 'GET /api/v1/projects': () => json({ projects: [] }) }

describe('run gallery — session states', () => {
  it('invites a signed-out reader to sign in, and points at the analyzer either way', async () => {
    installNetwork({ 'GET /api/v1/me': signedOutRoute })
    renderScreen(<RunsScreen />, { path: '/runs' })

    const panel = await screen.findByRole('region', { name: 'サインインが必要です' })
    expect(within(panel).getByRole('link', { name: 'サインイン' }).getAttribute('href')).toBe('/sign-in')
    expect(within(panel).getByRole('link', { name: '解析画面へ' }).getAttribute('href')).toBe('/')
  })

  it('offers no dead-end sign-in link when there is nothing to sign in to', async () => {
    installNetwork({ 'GET /api/v1/me': unavailableRoute })
    renderScreen(<RunsScreen />, { path: '/runs' })

    const panel = await screen.findByRole('region', { name: 'サインインが必要です' })
    expect(panel.textContent).toContain('このデプロイではクラウド機能を利用できません')
    expect(within(panel).queryByRole('link', { name: 'サインイン' })).toBeNull()
    expect(within(panel).getByRole('link', { name: '解析画面へ' })).toBeDefined()
  })
})

describe('run gallery — ordering', () => {
  it('shows experiment-date order, newest day first, suffix ascending within a day', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () =>
        json({
          // Deliberately the API's own order: newest *upload* first, which is the wrong answer.
          runs: [
            run({ id: '01J4', runCode: '260810a', experimentDate: '2026-08-10', suffix: 'a' }),
            run({ id: '01J3', runCode: '260811b', experimentDate: '2026-08-11', suffix: 'b' }),
            run({ id: '01J2', runCode: '260811a', experimentDate: '2026-08-11', suffix: 'a' }),
            run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12', suffix: '' }),
          ],
          nextCursor: null,
        }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    await screen.findByRole('heading', { name: '260812', level: 2 })
    const codes = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent ?? '')
    expect(codes).toEqual(['260812', '260811a', '260811b', '260810a'])
  })

  it('lists an undated run last rather than hiding it', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () =>
        json({
          runs: [
            run({ id: '01J9', runCode: 'saisokutei', originalFilename: '2026-08-11 再測定.csv' }),
            run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12' }),
          ],
          nextCursor: null,
        }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })
    await screen.findByRole('heading', { name: '260812', level: 2 })

    const codes = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '')
    expect(codes).toEqual(['260812', 'saisokutei'])
    // And says why it has no date, instead of leaving the reader to guess.
    expect(screen.getByText('命名規則外')).toBeDefined()
    expect(screen.getByText('日付なし')).toBeDefined()
  })
})

describe('run gallery — filtering', () => {
  it('sends the server-side filters as query parameters, only on submit', async () => {
    const network = installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () => json({ runs: [], nextCursor: null }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })
    await screen.findByRole('searchbox', { name: /^実験コード・ファイル名/ })
    const before = network.requestsTo('/api/v1/runs').length

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /^実験コード・ファイル名/ }), '260811')
    // `combobox`, not `textbox`: the tag field carries a `<datalist>` of the tags already loaded.
    await user.type(screen.getByRole('combobox', { name: /^タグ（完全一致）/ }), '再測定')

    // Typing must not fire a query per keystroke.
    expect(network.requestsTo('/api/v1/runs')).toHaveLength(before)

    await user.click(screen.getByRole('button', { name: '絞り込む' }))

    await waitFor(() => expect(network.requestsTo('/api/v1/runs').length).toBe(before + 1))
    const sent = new URL(network.requestsTo('/api/v1/runs').at(-1)?.url ?? '', 'https://aat.test')
    expect(sent.searchParams.get('search')).toBe('260811')
    expect(sent.searchParams.get('tag')).toBe('再測定')
    expect(sent.searchParams.get('limit')).toBe('50')
  })

  it('filters by memo in the browser, over loaded runs only, and says so', async () => {
    const network = installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () =>
        json({
          runs: [
            run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12', memo: '再測定 GQ良好' }),
            run({ id: '01J2', runCode: '260811a', experimentDate: '2026-08-11', memo: '初回' }),
          ],
          nextCursor: null,
        }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })
    await screen.findByRole('heading', { name: '260812', level: 2 })

    const memoField = screen.getByRole('searchbox', { name: /^メモ/ })
    // The label says where it filters, which is what makes an empty result readable.
    expect(memoField.closest('label')?.textContent).toContain('読み込み済みの実験だけを絞り込みます')

    const user = userEvent.setup()
    await user.type(memoField, '再測定')
    await user.click(screen.getByRole('button', { name: '絞り込む' }))

    await waitFor(() => expect(screen.queryByRole('heading', { name: '260811a', level: 2 })).toBeNull())
    expect(screen.getByRole('heading', { name: '260812', level: 2 })).toBeDefined()
    // No memo parameter was invented for the server.
    for (const request of network.requestsTo('/api/v1/runs')) {
      expect(request.url).not.toContain('memo=')
    }
  })

  it('distinguishes "nothing saved yet" from "nothing matches"', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () => json({ runs: [], nextCursor: null }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    const empty = await screen.findByRole('region', { name: '該当なし' })
    expect(empty.textContent).toContain('まだ実験が保存されていません')

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /^実験コード・ファイル名/ }), 'nothing')
    await user.click(screen.getByRole('button', { name: '絞り込む' }))

    await waitFor(() =>
      expect(screen.getByRole('region', { name: '該当なし' }).textContent).toContain(
        '条件に一致する実験はありません',
      ),
    )
  })

  it('enables "clear" only when something is actually filtered', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () => json({ runs: [], nextCursor: null }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })
    const clear = await screen.findByRole('button', { name: '条件をクリア' })
    expect(clear).toHaveProperty('disabled', true)

    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: /^実験コード・ファイル名/ }), '2608')
    await waitFor(() => expect(clear).toHaveProperty('disabled', false))

    await user.click(clear)
    await waitFor(() =>
      expect(screen.getByRole('searchbox', { name: /^実験コード・ファイル名/ })).toHaveProperty('value', ''),
    )
  })
})

describe('run gallery — loading, failure and paging', () => {
  it('says it is loading, then how many it is showing', async () => {
    let release: (value: Response) => void = () => {}
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () =>
        new Promise<Response>((resolve) => {
          release = resolve
        }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    await waitFor(() =>
      expect(
        screen.getAllByRole('status').some((node) => node.textContent?.includes('読み込んでいます')),
      ).toBe(true),
    )

    release(
      json({
        runs: [run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12' })],
        nextCursor: null,
      }),
    )
    await waitFor(() =>
      expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('1 件を表示中'))).toBe(
        true,
      ),
    )
  })

  it('surfaces a refusal as its message plus a retry, not as an HTTP number', async () => {
    let attempts = 0
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () => {
        attempts += 1
        return attempts === 1
          ? apiError(429, 'RATE_LIMITED', '要求が多すぎます。しばらく待ってから再試行してください。')
          : json({
              runs: [run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12' })],
              nextCursor: null,
            })
      },
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    const notice = await screen.findByText('要求が多すぎます。しばらく待ってから再試行してください。')
    expect(notice.textContent).not.toContain('429')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '再読み込み' }))
    expect(await screen.findByRole('heading', { name: '260812', level: 2 })).toBeDefined()
  })

  it('offers the next page only while the cursor says there is one', async () => {
    const network = installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': (request) => {
        const cursor = new URL(request.url, 'https://aat.test').searchParams.get('cursor')
        return cursor === null
          ? json({
              runs: [run({ id: '01J2', runCode: '260812', experimentDate: '2026-08-12' })],
              nextCursor: '01J2',
            })
          : json({
              runs: [run({ id: '01J1', runCode: '260810', experimentDate: '2026-08-10' })],
              nextCursor: null,
            })
      },
    })

    renderScreen(<RunsScreen />, { path: '/runs' })
    const more = await screen.findByRole('button', { name: 'さらに 50 件を読み込む' })

    const user = userEvent.setup()
    await user.click(more)

    expect(await screen.findByRole('heading', { name: '260810', level: 2 })).toBeDefined()
    await waitFor(() => expect(screen.queryByRole('button', { name: /さらに/ })).toBeNull())
    expect(network.requestsTo('/api/v1/runs').at(-1)?.url).toContain('cursor=01J2')
  })
})

describe('run gallery — a card', () => {
  it('identifies the experiment before any of the expensive half arrives', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      'GET /api/v1/runs': () =>
        json({
          runs: [
            run({
              id: '01J1',
              runCode: '260812',
              experimentDate: '2026-08-12',
              memo: '再測定',
              tags: ['GQ良好'],
            }),
          ],
          nextCursor: null,
        }),
      // The facts never arrive, so what is asserted is what the card shows without them.
      'GET /api/v1/runs/:runId/revisions': () => new Promise<Response>(() => {}),
      'GET /api/v1/revisions/:revisionId': () => new Promise<Response>(() => {}),
      'GET /api/v1/revisions/:revisionId/posters': () => new Promise<Response>(() => {}),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    const heading = await screen.findByRole('heading', { name: '260812', level: 2 })
    // The run code is a real link to the detail screen.
    expect(within(heading).getByRole('link').getAttribute('href')).toBe('/runs/01J1')
    expect(screen.getByText('260812_data.csv')).toBeDefined()
    expect(screen.getByText('再測定')).toBeDefined()
    expect(within(screen.getByRole('list', { name: 'タグ' })).getByText('GQ良好')).toBeDefined()
    // The statistics table exists and is captioned, with the numbers not yet known.
    expect(screen.getByRole('rowheader', { name: 'Inner Capsule' })).toBeDefined()
  })

  it('reports a failed facts load on the card and offers a retry that re-requests', async () => {
    let attempts = 0
    const network = installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      'GET /api/v1/runs': () =>
        json({
          runs: [run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12' })],
          nextCursor: null,
        }),
      'GET /api/v1/runs/:runId/revisions': () => {
        attempts += 1
        return attempts === 1
          ? apiError(500, 'INTERNAL', '一時的な問題が発生しました。')
          : json({ revisions: [] })
      },
      'GET /api/v1/revisions/:revisionId': () => json({ revision: null, config: null, metrics: null }),
      'GET /api/v1/revisions/:revisionId/posters': () => json({ posters: [] }),
    })

    renderScreen(<RunsScreen />, { path: '/runs' })

    const failure = await screen.findByText(/詳細を読み込めませんでした/)
    expect(failure.textContent).toContain('一時的な問題が発生しました。')
    // The run itself is not hidden by its facts failing.
    expect(screen.getByRole('heading', { name: '260812', level: 2 })).toBeDefined()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '再試行' }))
    await waitFor(() => expect(network.requestsTo('/api/v1/runs/01J1/revisions').length).toBe(2))
    await waitFor(() => expect(screen.queryByText(/詳細を読み込めませんでした/)).toBeNull())
  })

  it('names every control on the screen', async () => {
    installNetwork({
      'GET /api/v1/me': meRoute(),
      ...PROJECTS,
      ...NO_FACTS,
      'GET /api/v1/runs': () =>
        json({
          runs: [run({ id: '01J1', runCode: '260812', experimentDate: '2026-08-12' })],
          nextCursor: null,
        }),
    })

    const { container } = renderScreen(<RunsScreen />, { path: '/runs' })
    await screen.findByRole('heading', { name: '260812', level: 2 })
    expectEveryControlIsNamed(container)
    // A real `<search>` landmark rather than a role bolted onto the form.
    expect(container.querySelector('search')?.getAttribute('aria-label')).toBe('実験の絞り込み')
  })
})
