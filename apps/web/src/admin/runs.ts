/**
 * The deployment's experiments and where its bytes are, without ever loading the bytes.
 *
 * ## Why this screen's data comes from the member API, not from `/admin`
 *
 * There is no administrative run listing and there should not be one. `docs/cloud-data-model.md` is
 * explicit that `/admin` exposes metadata and never research data, and that an administrator reads
 * a colleague's work through the ordinary routes so that the read is resolved by one middleware,
 * attributed to an actor, and written to the owner's audit trail. `GET /api/v1/workspace/runs` is
 * that route: it needs `workspace:read`, which an Admin holds and a Viewer does not, and it returns
 * whose each run is. A second listing under `/admin` would be a second authorization path and a
 * read the owner never sees.
 *
 * ## What the API can filter, and what it cannot
 *
 * The route filters by run code and filename (`search`), tag, project, experiment-date bounds and
 * owner. It has no filter for *whether a run has a snapshot*, *whether it has an original-CSV
 * backup*, or *what state its poster is in*, because none of those is a column on `runs` — they are
 * facts about rows in other tables, and one join per listing row is the shape D1 charges for.
 *
 * So those three are resolved per run, on demand, for the page that is on screen, and the screen
 * says so. Two consequences are kept honest rather than smoothed over:
 *
 *  - **A client-side filter narrows only what has been inspected.** {@link matchesInspection}
 *    returns `unknown` for a run whose details have not been fetched, and the screen shows those
 *    rows rather than hiding them. A filter that silently dropped uninspected runs would make an
 *    empty result mean two different things.
 *  - **Source-backup availability cannot be answered at all.** The only route that touches a source
 *    backup is `GET /runs/:runId/source`, which streams the CSV — asking "is there one?" by
 *    downloading it would pull raw measurement data into an admin console to render a yes/no. That
 *    is a backend gap (a metadata endpoint would answer it in one row) and it is reported as one.
 */

import type { CloudOutcome, PosterFigure, RevisionSummary } from '../cloud/gateway.ts'
import { listPosters, listRevisions } from '../cloud/gateway.ts'
import { latestRevision } from '../runs/facts.ts'

/** Rows per page. The route's ceiling is 100; fifty is a screenful and one round trip. */
export const ADMIN_RUN_PAGE_SIZE = 50

/**
 * How many runs the screen will hold at once.
 *
 * A cursor listing invites "load more" until the browser is holding the whole deployment, which is
 * exactly what the brief forbids. Ten pages is enough to scroll through a year of drops and small
 * enough that the array is never the reason the tab is slow; past it the screen asks for a narrower
 * filter instead of quietly continuing.
 */
export const ADMIN_RUN_LIMIT = ADMIN_RUN_PAGE_SIZE * 10

export type PosterState = 'none' | 'ready' | 'rendering' | 'failed'

/** What one run's per-row lookup found. Never includes a sample, a series or a snapshot byte. */
export interface RunInspection {
  revisionCount: number
  /** The highest-numbered revision, which is the run's current analysis. */
  latest: RevisionSummary | null
  /** True when at least one revision has its snapshot object attached. */
  hasSnapshot: boolean
  posters: readonly PosterFigure[]
  posterState: PosterState
  /** Figures whose render failed, newest first — the retry queue, if the operator wants one. */
  failedPosters: readonly PosterFigure[]
}

/**
 * Reduce a revision's figures to one word.
 *
 * `failed` outranks `ready` deliberately. A revision whose automatic figure failed and whose custom
 * figure rendered is a revision with a problem, and a summary that reported the good news would
 * hide the row an operator opened this screen to find. `rendering` outranks `ready` for the same
 * reason in the other direction: something is in flight and that is the current fact.
 */
export function posterStateOf(posters: readonly PosterFigure[]): PosterState {
  if (posters.length === 0) return 'none'
  if (posters.some((poster) => poster.status === 'failed')) return 'failed'
  if (posters.some((poster) => poster.status === 'rendering' || poster.status === 'queued')) {
    return 'rendering'
  }
  return posters.some((poster) => poster.status === 'ready') ? 'ready' : 'none'
}

export const POSTER_STATE_LABELS: Readonly<Record<PosterState, string>> = {
  none: '未生成',
  ready: '生成済み',
  rendering: '生成中',
  failed: '失敗あり',
}

/**
 * Two requests per run: its revisions, then the latest revision's figures.
 *
 * Deliberately not `loadRunFacts` from `src/runs/facts.ts`, which makes a third request for the
 * headline metrics. The gallery needs those because it prints a mean; this screen prints
 * availability and would be paying a round trip per row for numbers it never shows.
 */
export async function inspectRun(runId: string): Promise<CloudOutcome<RunInspection>> {
  const revisionsOutcome = await listRevisions(runId)
  if (!revisionsOutcome.ok) return revisionsOutcome

  const revisions = revisionsOutcome.value.revisions
  const latest = latestRevision(revisions)
  const hasSnapshot = revisions.some((revision) => revision.hasSnapshot)

  if (latest === null) {
    return {
      ok: true,
      value: {
        revisionCount: 0,
        latest: null,
        hasSnapshot: false,
        posters: [],
        posterState: 'none',
        failedPosters: [],
      },
    }
  }

  const postersOutcome = await listPosters(latest.id)
  // A refused poster listing is not a failed inspection: the revision count and the snapshot answer
  // already arrived, and showing them with an unknown poster state is more use than showing an
  // error where the whole row would be.
  const posters = postersOutcome.ok ? postersOutcome.value.posters : []

  return {
    ok: true,
    value: {
      revisionCount: revisions.length,
      latest,
      hasSnapshot,
      posters,
      posterState: posterStateOf(posters),
      failedPosters: posters.filter((poster) => poster.status === 'failed'),
    },
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Filters                                                                                      */
/* ------------------------------------------------------------------------------------------- */

export interface AdminRunFilter {
  /** Server-side: substring of the run code or the original filename. */
  search: string
  /** Server-side: exact tag. */
  tag: string
  /** Server-side: inclusive experiment-date bounds, `YYYY-MM-DD`. */
  from: string
  to: string
  /** Server-side: one member's runs. */
  ownerUserId: string
  /** Client-side, and only over rows that have been inspected. */
  snapshot: 'any' | 'yes' | 'no'
  poster: 'any' | PosterState
}

export const EMPTY_ADMIN_RUN_FILTER: AdminRunFilter = {
  search: '',
  tag: '',
  from: '',
  to: '',
  ownerUserId: '',
  snapshot: 'any',
  poster: 'any',
}

/** True when nothing is narrowed. Used to phrase an empty result as "none exist" rather than "none match". */
export function isEmptyAdminRunFilter(filter: AdminRunFilter): boolean {
  return (
    filter.search.trim() === '' &&
    filter.tag.trim() === '' &&
    filter.from === '' &&
    filter.to === '' &&
    filter.ownerUserId === '' &&
    filter.snapshot === 'any' &&
    filter.poster === 'any'
  )
}

/** True when the filter asks a question only an inspection can answer. */
export function needsInspection(filter: AdminRunFilter): boolean {
  return filter.snapshot !== 'any' || filter.poster !== 'any'
}

export interface AdminRunServerQuery {
  limit: number
  cursor?: string
  search?: string
  tag?: string
  from?: string
  to?: string
  ownerUserId?: string
}

/** Only the parameters the route accepts, and only the ones that were actually set. */
export function adminRunQueryFor(filter: AdminRunFilter, cursor: string | null): AdminRunServerQuery {
  const query: AdminRunServerQuery = { limit: ADMIN_RUN_PAGE_SIZE }
  if (cursor !== null) query.cursor = cursor
  const search = filter.search.trim()
  const tag = filter.tag.trim()
  if (search !== '') query.search = search
  if (tag !== '') query.tag = tag
  if (filter.from !== '') query.from = filter.from
  if (filter.to !== '') query.to = filter.to
  if (filter.ownerUserId !== '') query.ownerUserId = filter.ownerUserId
  return query
}

/**
 * Does an inspected run match the client-side half of the filter?
 *
 * `'unknown'` for a run that has not been inspected, and the caller shows it. Hiding a row because
 * the console has not looked at it yet would mean the answer to "which runs have no snapshot?"
 * depends on how far the reader has scrolled.
 */
export function matchesInspection(
  inspection: RunInspection | undefined,
  filter: AdminRunFilter,
): true | false | 'unknown' {
  if (filter.snapshot === 'any' && filter.poster === 'any') return true
  if (inspection === undefined) return 'unknown'
  if (filter.snapshot === 'yes' && !inspection.hasSnapshot) return false
  if (filter.snapshot === 'no' && inspection.hasSnapshot) return false
  if (filter.poster !== 'any' && inspection.posterState !== filter.poster) return false
  return true
}

/* ------------------------------------------------------------------------------------------- */
/* Storage rows                                                                                 */
/* ------------------------------------------------------------------------------------------- */

/** Per-user storage rows per page. The report itself is capped at 200 rows by the route. */
export const STORAGE_PAGE_SIZE = 25

/** One page of an already-sorted array. Pure, so the screen holds a page number and nothing else. */
export function pageOf<T>(rows: readonly T[], page: number, size: number): readonly T[] {
  const start = Math.max(0, page) * size
  return rows.slice(start, start + size)
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}
