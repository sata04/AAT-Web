// @vitest-environment jsdom
/**
 * Gallery ordering and filtering.
 *
 * The property under test is the one the API cannot provide: `GET /api/v1/runs` orders by
 * `desc(runs.id)`, which is upload order, and the gallery must never show that. So these tests
 * deliberately feed the comparator arrays whose incoming order is *wrong* in the way a real page
 * would be wrong — a run analysed months late sitting first — and assert that the displayed order
 * is experiment order regardless.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '../../src/cloud/gateway.ts'
import { listRevisions, listRuns, listWorkspaceRuns } from '../../src/cloud/gateway.ts'
import {
  compareRuns,
  followsFilenameConvention,
  isEmptyFilter,
  knownTags,
  matchesMemoFilter,
  mergeRunPages,
  presentRuns,
  RUNS_PAGE_SIZE,
  serverQueryFor,
  sortKeyFor,
  sortRuns,
} from '../../src/runs/gallery.ts'
import { RunsScreen } from '../../src/screens/RunsScreen.tsx'

/** A run row as the listing route returns it. `id` is a ULID; later id means later upload. */
function run(overrides: Partial<RunSummary> & { id: string; runCode: string }): RunSummary {
  return {
    experimentDate: null,
    suffix: '',
    originalFilename: `${overrides.runCode}_data.csv`,
    memo: null,
    tags: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  }
}

function dated(id: string, runCode: string, date: string, suffix = ''): RunSummary {
  return run({ id, runCode, experimentDate: date, suffix, originalFilename: `${runCode}_data.csv` })
}

describe('gallery ordering', () => {
  it('orders by experiment date descending, not by upload order', () => {
    // `01J...C` was uploaded last but measured first: id order and date order disagree.
    const rows = [
      dated('01JC', '260601', '2026-06-01'),
      dated('01JA', '260810', '2026-08-10'),
      dated('01JB', '260812', '2026-08-12'),
    ]
    expect(sortRuns(rows).map((entry) => entry.runCode)).toEqual(['260812', '260810', '260601'])
  })

  it('orders a day’s drops forwards: no suffix, then a, then b', () => {
    const rows = [
      dated('01J3', '260811b', '2026-08-11', 'b'),
      dated('01J1', '260811', '2026-08-11', ''),
      dated('01J2', '260811a', '2026-08-11', 'a'),
    ]
    // The suffix is a within-day sequence letter, so inside one date the order is the order the
    // capsule was dropped. Reversing it would put the day's last drop at the top of its own block.
    expect(sortRuns(rows).map((entry) => entry.runCode)).toEqual(['260811', '260811a', '260811b'])
  })

  it('keeps an unconventionally named run, and sorts it after every dated run', () => {
    const odd = run({ id: '01JZ', runCode: '260813', originalFilename: '再測定 2026-08-13.csv' })
    const rows = [odd, dated('01JA', '260810', '2026-08-10')]

    expect(followsFilenameConvention(odd)).toBe(false)
    // Present, not hidden — a gallery that drops a run because its name is unusual has lost it.
    expect(sortRuns(rows)).toHaveLength(2)
    // Its run code still places it: 260813 is a real date, so it sorts as one.
    expect(sortRuns(rows).map((entry) => entry.runCode)).toEqual(['260813', '260810'])
  })

  it('places a run with no derivable date after every dated run', () => {
    const undatable = run({ id: '01JY', runCode: '999999', originalFilename: 'zz.csv' })
    const rows = [undatable, dated('01JA', '260810', '2026-08-10')]
    expect(sortRuns(rows).map((entry) => entry.runCode)).toEqual(['260810', '999999'])
    expect(sortKeyFor(undatable).experimentDate).toBeNull()
  })

  it('derives the date from the run code when the row has none', () => {
    // POST /runs accepts a runCode without an experimentDate. The date is knowable, so it is used.
    const explicit = run({ id: '01JX', runCode: '260805a', originalFilename: 'lab notes copy.csv' })
    expect(sortKeyFor(explicit)).toEqual({
      experimentDate: '2026-08-05',
      suffix: 'a',
      originalFilename: 'lab notes copy.csv',
    })
  })

  it('is total: equal gallery keys never fall back to array order', () => {
    // Two undated runs with the same filename — possible, because uniqueness is on the run code.
    const a = run({ id: '01JB', runCode: '999998', originalFilename: 'same.csv' })
    const b = run({ id: '01JA', runCode: '999999', originalFilename: 'same.csv' })
    expect(compareRuns(a, b)).toBeLessThan(0)
    expect(compareRuns(b, a)).toBeGreaterThan(0)
    expect(compareRuns(a, a)).toBe(0)
    // And the answer does not depend on which way round they arrived.
    expect(sortRuns([a, b]).map((entry) => entry.id)).toEqual(sortRuns([b, a]).map((entry) => entry.id))
  })

  it('does not mutate the array it was given', () => {
    const rows = [dated('01JA', '260601', '2026-06-01'), dated('01JB', '260812', '2026-08-12')]
    const before = rows.map((entry) => entry.id)
    sortRuns(rows)
    expect(rows.map((entry) => entry.id)).toEqual(before)
  })
})

describe('gallery filtering', () => {
  it('sends only the filters D1 can honour, and omits blank ones', () => {
    const query = serverQueryFor(
      {
        search: ' 260811 ',
        tag: 'GQ',
        from: '2026-08-01',
        to: '',
        memo: '再測定',
      },
      null,
    )
    expect(query).toEqual({ limit: RUNS_PAGE_SIZE, search: '260811', tag: 'GQ', from: '2026-08-01' })
    // The memo is deliberately absent: the route has no memo filter, so sending one would be
    // silently ignored and the screen would be claiming a narrowing it did not get.
    expect(query).not.toHaveProperty('memo')
    expect(query).not.toHaveProperty('to')
  })

  it('passes the cursor through for the next page', () => {
    const query = serverQueryFor({ search: '', tag: '', from: '', to: '', memo: '' }, '01JCURSOR')
    expect(query).toEqual({ limit: RUNS_PAGE_SIZE, cursor: '01JCURSOR' })
  })

  it('filters memos client-side, case-folded, over loaded runs only', () => {
    const withMemo = run({ id: '01JA', runCode: '260810', memo: '再測定（GQ 不良のため）' })
    const withoutMemo = run({ id: '01JB', runCode: '260811' })
    expect(matchesMemoFilter(withMemo, 'gq')).toBe(true)
    expect(matchesMemoFilter(withMemo, '再測定')).toBe(true)
    expect(matchesMemoFilter(withoutMemo, '再測定')).toBe(false)
    // An empty filter matches everything, including a run with no memo at all.
    expect(matchesMemoFilter(withoutMemo, '   ')).toBe(true)
  })

  it('applies the memo filter and the gallery order together', () => {
    const rows = [
      dated('01JA', '260810', '2026-08-10'),
      { ...dated('01JB', '260812', '2026-08-12'), memo: '良好' },
      { ...dated('01JC', '260601', '2026-06-01'), memo: '良好だが振動あり' },
    ]
    const shown = presentRuns(rows, {
      search: '',
      tag: '',
      from: '',
      to: '',
      memo: '良好',
    })
    expect(shown.map((entry) => entry.runCode)).toEqual(['260812', '260601'])
  })

  it('knows when nothing is being filtered', () => {
    expect(isEmptyFilter({ search: '', tag: '', from: '', to: '', memo: '' })).toBe(true)
    expect(isEmptyFilter({ search: '  ', tag: '', from: '', to: '', memo: '' })).toBe(true)
    expect(isEmptyFilter({ search: '', tag: '', from: '2026-01-01', to: '', memo: '' })).toBe(false)
  })
})

describe('page merging', () => {
  it('is idempotent and lets a refetched row win', () => {
    const first = [run({ id: '01JA', runCode: '260810', memo: 'old' })]
    const refetched = [run({ id: '01JA', runCode: '260810', memo: 'new' })]
    const merged = mergeRunPages(first, refetched)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.memo).toBe('new')
  })

  it('collects the distinct tags of everything loaded', () => {
    const rows = [
      run({ id: '01JA', runCode: '260810', tags: ['thesis', 'calibration'] }),
      run({ id: '01JB', runCode: '260811', tags: ['calibration'] }),
    ]
    expect(knownTags(rows)).toEqual(['calibration', 'thesis'])
  })
})

vi.mock('../../src/session/SessionProvider.tsx', () => ({
  useSession: () => ({ status: 'signed-in', capabilities: ['workspace:read'] }),
}))
vi.mock('../../src/components/ScreenFrame.tsx', () => ({
  ScreenFrame: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock('../../src/router/Router.tsx', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    createElement('a', { href: to }, children),
}))
vi.mock('../../src/cloud/gateway.ts', async (original) => ({
  ...(await original<object>()),
  listRuns: vi.fn(),
  listWorkspaceRuns: vi.fn(),
  listRevisions: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('gallery request lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listRevisions).mockResolvedValue({ ok: true, value: { revisions: [] } })
  })
  afterEach(cleanup)

  it('loads cards and their facts after StrictMode effect replay', async () => {
    const rows = [
      { ...run({ id: 'strict', runCode: '260811' }), ownerUserId: 'owner', ownerDisplayName: 'Researcher' },
    ]
    vi.mocked(listWorkspaceRuns).mockResolvedValue({ ok: true, value: { runs: rows, nextCursor: null } })
    render(createElement(StrictMode, null, createElement(RunsScreen)))
    expect(await screen.findByText('260811')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('読み込んでいます…')).toBeNull())
    expect(await screen.findByText('ポスター図なし')).toBeTruthy()
    expect(listRevisions).toHaveBeenCalledWith('strict')
  })

  it('keeps the newest scope and cursor when the older scope finishes last', async () => {
    const team = deferred<Awaited<ReturnType<typeof listWorkspaceRuns>>>()
    vi.mocked(listWorkspaceRuns).mockReturnValue(team.promise)
    vi.mocked(listRuns).mockResolvedValue({
      ok: true,
      value: { runs: [run({ id: 'mine', runCode: '260812' })], nextCursor: null },
    })
    render(createElement(RunsScreen))
    fireEvent.click(screen.getByRole('radio', { name: /自分のみ/ }))
    expect(await screen.findByText('260812')).toBeTruthy()
    await act(async () =>
      team.resolve({
        ok: true,
        value: {
          runs: [
            {
              ...run({ id: 'team', runCode: '260810' }),
              ownerUserId: 'owner',
              ownerDisplayName: 'Researcher',
            },
          ],
          nextCursor: 'obsolete',
        },
      }),
    )
    expect(screen.getByText('260812')).toBeTruthy()
    expect(screen.queryByText('260810')).toBeNull()
    expect(screen.queryByRole('button', { name: /さらに \d+ 件を読み込む/ })).toBeNull()
  })

  it('discards an obsolete page after a new filter is applied', async () => {
    const page = deferred<Awaited<ReturnType<typeof listWorkspaceRuns>>>()
    vi.mocked(listWorkspaceRuns)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          runs: [
            {
              ...run({ id: 'first', runCode: '260811' }),
              ownerUserId: 'owner',
              ownerDisplayName: 'Researcher',
            },
          ],
          nextCursor: 'page-two',
        },
      })
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce({
        ok: true,
        value: {
          runs: [
            {
              ...run({ id: 'filtered', runCode: '260813' }),
              ownerUserId: 'owner',
              ownerDisplayName: 'Researcher',
            },
          ],
          nextCursor: null,
        },
      })
    render(createElement(RunsScreen))
    await screen.findByText('260811')
    fireEvent.click(screen.getByRole('button', { name: /読み込む/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: /実験コード/ }), { target: { value: '260813' } })
    const form = screen.getByRole('searchbox', { name: /実験コード/ }).closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)
    await screen.findByText('260813')
    await act(async () =>
      page.resolve({
        ok: true,
        value: {
          runs: [
            {
              ...run({ id: 'old-page', runCode: '260809' }),
              ownerUserId: 'owner',
              ownerDisplayName: 'Researcher',
            },
          ],
          nextCursor: 'stale-cursor',
        },
      }),
    )
    expect(screen.queryByText('260809')).toBeNull()
    expect(screen.getByText('260813')).toBeTruthy()
  })
})
