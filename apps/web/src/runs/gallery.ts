/**
 * Ordering, filtering and paging for the Run Gallery.
 *
 * Pure functions, no React, no fetch — the interesting decisions in a gallery are "which run comes
 * first" and "does this run match what was typed", and both are worth testing without a DOM.
 *
 * ## Why the sort is not the API's sort
 *
 * `GET /api/v1/runs` orders by `desc(runs.id)`. The ids are ULIDs, so that is *upload* order, and
 * it is exactly right for keyset pagination — "everything after this id" stays a stable page
 * boundary while new runs are being created, which an OFFSET does not. It is exactly wrong as a
 * gallery order, because a researcher who analyses last month's file today would see it above this
 * morning's drop. The listing is therefore paged by id and *displayed* by experiment date.
 *
 * ## Which way the suffix runs, and why
 *
 * Within one date the order is suffix **ascending** — `260811` before `260811a` before `260811b` —
 * while the dates themselves run newest first. That asymmetry is deliberate and it is
 * `compareRunGalleryEntries` in `@aat/shared`, which this module delegates to rather than
 * reimplementing.
 *
 * The reason is what the suffix *is*. `docs/cloud-data-model.md` states it: the suffix is a
 * within-day sequence letter, assigned in the order the capsule was dropped, so `a` is the day's
 * first drop and `b` its second. Between days, "newest first" is what a gallery is for. Inside a
 * day, the two drops are one session, and a session reads forwards: `a` then `b` is the order the
 * experiments happened in, the order the lab notebook has them in, and the order the run codes
 * were minted in. Reversing it to `b, a` would make the ordering non-monotonic in time — descending
 * across dates and descending within them would at least be consistent, but it would put the
 * *last* drop of a session at the top of that session's block, which is not how anybody refers to
 * a day's runs.
 *
 * A run whose filename never parsed sorts after every dated run, by filename. That is the shared
 * comparator's rule and it exists so an unconventionally named upload lands in one predictable
 * place instead of scattering through the gallery. It is never *hidden*: see `sortKeyFor`.
 */

import { compareRunGalleryEntries, parseRunFilename, type RunGallerySortKey } from '@aat/shared'
import { type CloudOutcome, listRuns, type RunListQuery, type RunSummary } from '../cloud/gateway.ts'

/**
 * Rows requested per page.
 *
 * The route's own default is 25 and its ceiling is 100. Fifty is one D1 query for a card grid that
 * is a couple of scrolls deep, which is the size at which "load the next page" is a deliberate act
 * rather than something the user does four times to see one week of work.
 */
export const RUNS_PAGE_SIZE = 50

/**
 * The ceiling on how many runs the browser holds at once.
 *
 * The gallery sorts what it has loaded, so more loaded means a more complete ordering — but this
 * must not become "fetch everything and sort in JavaScript". Ten pages is a hard stop, and when it
 * is reached the screen says so and points at the filters, which push the work back into D1's
 * WHERE clause where it belongs. A lab with more than five hundred runs on screen at once is not
 * looking at a gallery, it is looking for something specific.
 */
export const MAX_LOADED_RUNS = RUNS_PAGE_SIZE * 10

/**
 * The sort key for one run.
 *
 * Three sources, in falling order of authority, and the fallbacks matter more than they look:
 *
 *  1. **The row's own `experimentDate` / `suffix`.** The Worker wrote these when the run was
 *     created, from `parseRunFilename` or from an explicit `runCode` the user supplied for a file
 *     that did not follow the convention. It is the authority.
 *  2. **The run code**, when the row has no date. `POST /runs` accepts a `runCode` without an
 *     `experimentDate`, which leaves a run that we *can* place — `260811b` is unambiguously the
 *     11th of August — recorded as undated. Rather than re-implementing the six-digit convention
 *     here, the code is handed back to `parseRunFilename` in the shape it reads. That keeps
 *     `run-code.ts` the only thing in the repository that knows what `260811b` means, which is
 *     the property `docs/cloud-data-model.md` asks for.
 *  3. **Nothing.** A null date is a legitimate outcome and is not an error: the comparator places
 *     such runs after every dated one, ordered by filename. The run is still listed, still
 *     searchable and still openable — a gallery that hides a run because its name is unusual has
 *     lost the run.
 */
export function sortKeyFor(run: RunSummary): RunGallerySortKey {
  if (run.experimentDate !== null) {
    return {
      experimentDate: run.experimentDate,
      suffix: run.suffix,
      originalFilename: run.originalFilename,
    }
  }
  const fromCode = parseRunFilename(`${run.runCode}_data.csv`)
  return {
    experimentDate: fromCode.experimentDate,
    suffix: fromCode.suffix ?? run.suffix,
    originalFilename: run.originalFilename,
  }
}

/**
 * Total order over runs.
 *
 * `compareRunGalleryEntries` can return 0 — two undated runs that happen to share a filename, which
 * is possible because uniqueness is on the run code, not the name. `Array.prototype.sort` is stable,
 * so a tie would silently fall back to the order the array arrived in, and that order is the API's
 * `desc(runs.id)`: upload order, the one thing this sort exists to not be. The run code breaks the
 * tie (unique per owner, so it always can), and the id is there so the function is total even for
 * data this client did not anticipate.
 */
export function compareRuns(a: RunSummary, b: RunSummary): number {
  const byGalleryOrder = compareRunGalleryEntries(sortKeyFor(a), sortKeyFor(b))
  if (byGalleryOrder !== 0) return byGalleryOrder
  if (a.runCode !== b.runCode) return a.runCode < b.runCode ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** Newest experiment date first, suffix ascending within a date, undated last. Does not mutate. */
export function sortRuns<T extends RunSummary>(runs: readonly T[]): T[] {
  return [...runs].sort(compareRuns)
}

/**
 * Whether a run's filename follows the `YYMMDD[a-z]_data.csv` convention.
 *
 * Shown as a quiet marker, never as a warning and never as a reason to exclude anything. A file
 * called `2026-08-11 再測定.csv` analysed with a hand-typed run code is a completely valid record;
 * the marker exists so that someone wondering why a run has no date has the answer on the card.
 */
export function followsFilenameConvention(run: RunSummary): boolean {
  return parseRunFilename(run.originalFilename).matched
}

/**
 * The filters the gallery offers, split by where each one is applied.
 *
 * The split is not an implementation detail to hide — it decides what the results *mean*, so the
 * screen labels each control with where it filters:
 *
 *  - `search`, `tag`, `from`, `to` go to D1 in the WHERE clause of a paged query. They narrow the
 *    whole collection.
 *  - `memo` cannot. `GET /api/v1/runs` matches `search` against the run code and the original
 *    filename only, and there is no memo filter; adding one is a Worker change, not a client one.
 *    So memo filtering is applied to the runs already loaded, and the screen says so rather than
 *    letting a researcher conclude that no run mentions "再測定".
 */
export interface RunFilter {
  /** Server-side: substring of the run code or the original filename. */
  search: string
  /** Server-side: exact tag match. Tags are how runs are grouped — there is no other grouping. */
  tag: string
  /** Server-side: inclusive experiment-date bounds, `YYYY-MM-DD`. */
  from: string
  to: string
  /** Client-side, over loaded runs only. */
  memo: string
}

export const EMPTY_RUN_FILTER: RunFilter = {
  search: '',
  tag: '',
  from: '',
  to: '',
  memo: '',
}

/** True when nothing is being filtered, so the empty state can say "no runs" rather than "no matches". */
export function isEmptyFilter(filter: RunFilter): boolean {
  return (
    filter.search.trim() === '' &&
    filter.tag.trim() === '' &&
    filter.from === '' &&
    filter.to === '' &&
    filter.memo.trim() === ''
  )
}

/** The subset of `RunListQuery` this gallery ever sends. Structurally assignable to it. */
export interface RunListServerQuery {
  search?: string
  tag?: string
  from?: string
  to?: string
  limit: number
  cursor?: string
}

/**
 * The query the Worker understands, built from the parts of the filter it can honour.
 *
 * Blank fields are omitted rather than sent empty: `?search=` would be a zero-length `LIKE '%%'`,
 * which matches everything and costs a scan to say so.
 */
export function serverQueryFor(filter: RunFilter, cursor: string | null): RunListServerQuery {
  const query: RunListServerQuery = { limit: RUNS_PAGE_SIZE }
  const search = filter.search.trim()
  const tag = filter.tag.trim()
  if (search !== '') query.search = search
  if (tag !== '') query.tag = tag
  if (filter.from !== '') query.from = filter.from
  if (filter.to !== '') query.to = filter.to
  if (cursor !== null) query.cursor = cursor
  return query
}

/**
 * The client-side half of the filter: memo text.
 *
 * Case-folded with `toLocaleLowerCase`, which is a no-op for Japanese and the right behaviour for
 * the Latin fragments (`GQ`, `NG`, a colleague's initials) that turn up in these memos. Nothing
 * here interprets the memo as markup — see `RunMemoEditor`; it is text, matched as text.
 */
export function matchesMemoFilter(run: RunSummary, memoFilter: string): boolean {
  const needle = memoFilter.trim().toLocaleLowerCase()
  if (needle === '') return true
  return (run.memo ?? '').toLocaleLowerCase().includes(needle)
}

/** Apply the client-side filter and the gallery order in one pass, for a screen that wants both. */
export function presentRuns<T extends RunSummary>(runs: readonly T[], filter: RunFilter): T[] {
  return sortRuns(runs.filter((run) => matchesMemoFilter(run, filter.memo)))
}

/**
 * Merge a freshly loaded page into what is already held.
 *
 * Keyset pagination cannot repeat a row, but a *reloaded first page* can — the user edits a memo,
 * the screen refetches, and the same ids come back. Keying by id makes the merge idempotent, and
 * later rows win so a reload shows the edit rather than the copy that was already in memory.
 */
export function mergeRunPages<T extends RunSummary>(existing: readonly T[], incoming: readonly T[]): T[] {
  const byId = new Map<string, T>()
  for (const run of existing) byId.set(run.id, run)
  for (const run of incoming) byId.set(run.id, run)
  return [...byId.values()]
}

/* --------------------------------------------------------------------------------------------- */
/* Presentation                                                                                    */
/* --------------------------------------------------------------------------------------------- */

/**
 * The experiment date, as stored.
 *
 * `YYYY-MM-DD` is left alone rather than run through `toLocaleDateString`. The value is already an
 * unambiguous calendar date with no time and no zone, and putting it through a `Date` would attach
 * a UTC midnight to it that a reader west of Greenwich would see as the previous day. A run code is
 * six digits of date; the date beside it must be the same day.
 */
export function formatExperimentDate(iso: string | null): string {
  return iso ?? '日付なし'
}

/** A timestamp to the minute, in the reader's locale. Revision history is not a stopwatch. */
export function formatMoment(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * The within-day suffix, spelled out.
 *
 * An empty suffix is shown as なし rather than omitted, because "this run has no suffix" and "this
 * card forgot to show the suffix" would otherwise look identical — and the difference is whether
 * the day held one drop or several.
 */
export function suffixLabel(suffix: string): string {
  return suffix === '' ? 'なし' : suffix
}

/** Every distinct tag on the loaded runs, sorted, for the tag field's `<datalist>`. */
export function knownTags(runs: readonly RunSummary[]): string[] {
  const tags = new Set<string>()
  for (const run of runs) for (const tag of run.tags) tags.add(tag)
  return [...tags].sort((left, right) => left.localeCompare(right, 'ja'))
}

/* ------------------------------------------------------------------------------------------- */
/* Scope: whose runs the gallery is showing                                                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * The two listings the gallery can read.
 *
 * These are two Worker routes with two different authorizations, not one route with a parameter —
 * see the note on `listWorkspaceRuns` in cloud/gateway.ts. Keeping them distinct here as well means
 * the screen cannot accidentally ask for the team's runs on behalf of somebody who may not see
 * them and then quietly render a narrowed list.
 */
export type RunScope = 'mine' | 'team'

/**
 * A gallery row, from either listing.
 *
 * The owner fields are nullable rather than optional so that "this row came from the owner-scoped
 * listing" is a value the renderer can branch on, instead of an absence it has to guess about. In
 * `mine` scope every row belongs to the caller, so naming them would be repeating the scope
 * selector on every card.
 */
export interface GalleryRun extends RunSummary {
  ownerUserId: string | null
  ownerDisplayName: string | null
}

/**
 * The caller's own runs, shaped like a gallery page.
 *
 * `GET /runs` predates the team listing and returns rows without an owner. Rather than teach the
 * card two row shapes, the two are made one here — at the only point where the difference is known
 * for certain.
 */
export async function listOwnRunsAsGallery(
  query: RunListQuery,
): Promise<CloudOutcome<{ runs: readonly GalleryRun[]; nextCursor: string | null }>> {
  const outcome = await listRuns(query)
  if (!outcome.ok) return outcome
  return {
    ok: true,
    value: {
      runs: outcome.value.runs.map((run) => ({ ...run, ownerUserId: null, ownerDisplayName: null })),
      nextCursor: outcome.value.nextCursor,
    },
  }
}
