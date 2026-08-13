/**
 * The per-run detail a gallery card shows, and the bounded way it is fetched.
 *
 * ## Why this is a second request at all
 *
 * `GET /api/v1/runs` returns run metadata and nothing else: code, date, suffix, filename, memo,
 * project, tags, timestamps. Everything else a card is supposed to show — the revision history, the
 * headline metrics, the G-quality summary, whether a snapshot exists, whether a poster has been
 * rendered — lives on other tables behind other routes. There is no "gallery" endpoint that joins
 * them, and writing one is a Worker change this screen is not allowed to make. See the report's
 * backend-gap note: a `GET /runs?expand=latest` would collapse three requests per card into zero.
 *
 * ## Why it is lazy and bounded rather than eager
 *
 * Three requests per run, times a fifty-row page, is a hundred and fifty requests to draw a screen
 * on which a reader will look at perhaps six cards. So a card asks for its own facts when it
 * actually becomes visible, and {@link BoundedFactLoader} keeps a small number of those in flight
 * at once. The cost of scrolling past a card is then three cheap D1 reads, and the cost of not
 * scrolling is nothing.
 *
 * ## Nothing here renders a poster
 *
 * `listPosters` is a `SELECT` over `poster_figures` and `posterImageUrl` is a `GET` of bytes that
 * already exist. The render endpoints are POSTs and live in `./api.ts`, wired only to buttons.
 * Opening the gallery must never cost container time, and the way that is guaranteed is that the
 * gallery has no code path that could ask for it.
 */

import type { CloudOutcome, PosterFigure, RevisionSummary } from '../cloud/gateway.ts'
import { fetchRevision, listPosters, listRevisions } from '../cloud/gateway.ts'
import { decodeRunMetrics, type RunMetrics } from './metrics.ts'

export interface RunFacts {
  /** Oldest first, as the route returns them. */
  revisions: readonly RevisionSummary[]
  /** The highest revision number, which is the run's current analysis. Null when there are none. */
  latest: RevisionSummary | null
  /** The latest revision's headline numbers, or null when it has no metrics row. */
  metrics: RunMetrics | null
  posters: readonly PosterFigure[]
  /** The automatic formal figure for the latest revision, if one has been rendered. */
  autoPoster: PosterFigure | null
}

const NO_FACTS: RunFacts = {
  revisions: [],
  latest: null,
  metrics: null,
  posters: [],
  autoPoster: null,
}

/** What a card knows about its own facts. `idle` is the state before it has ever been visible. */
export type RunFactsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; facts: RunFacts }
  | { kind: 'error'; message: string }

/**
 * Pick the run's current analysis.
 *
 * By revision *number*, not by position or by `createdAt`. The number is derived server-side as
 * `MAX(revision_number) + 1` under a unique index, so it is the one field that is guaranteed to
 * order the revisions of a run totally; two revisions created in the same millisecond by two
 * devices would tie on a timestamp.
 */
export function latestRevision(revisions: readonly RevisionSummary[]): RevisionSummary | null {
  let latest: RevisionSummary | null = null
  for (const revision of revisions) {
    if (latest === null || revision.revisionNumber > latest.revisionNumber) latest = revision
  }
  return latest
}

/** The automatic figure among a revision's posters, preferring a rendered one over a failed one. */
export function pickAutoPoster(posters: readonly PosterFigure[]): PosterFigure | null {
  const auto = posters.filter((poster) => poster.kind === 'auto')
  return auto.find((poster) => poster.status === 'ready') ?? auto[0] ?? null
}

/**
 * Load everything a card shows beyond the run row itself.
 *
 * Three requests, in dependency order: the revisions, then the latest revision's metrics and its
 * posters. A run with no revisions short-circuits after the first — it is a recorded experiment
 * that has not been analysed into the cloud yet, which is a legitimate state and not an error.
 *
 * The metrics and the posters are requested together rather than in sequence: neither needs the
 * other, and a card that waits for two round trips instead of one is a card that is still blank
 * when the reader has scrolled past it.
 */
export async function loadRunFacts(runId: string): Promise<CloudOutcome<RunFacts>> {
  const revisionsOutcome = await listRevisions(runId)
  if (!revisionsOutcome.ok) return revisionsOutcome

  const revisions = revisionsOutcome.value.revisions
  const latest = latestRevision(revisions)
  if (latest === null) return { ok: true, value: { ...NO_FACTS, revisions } }

  const [revisionOutcome, postersOutcome] = await Promise.all([
    fetchRevision(latest.id),
    listPosters(latest.id),
  ])

  // A failure on either half is not a failure of the card. The revision list already arrived, and
  // showing it with an em dash where a mean would be is more use than showing an error where the
  // whole card would be.
  const metrics = revisionOutcome.ok ? decodeRunMetrics(revisionOutcome.value.metrics) : null
  const posters = postersOutcome.ok ? postersOutcome.value.posters : []

  return {
    ok: true,
    value: { revisions, latest, metrics, posters, autoPoster: pickAutoPoster(posters) },
  }
}

/**
 * A queue that keeps at most `limit` loads in flight and never loads the same key twice.
 *
 * Small on purpose. The alternative shapes are worse in specific ways: firing every request at once
 * makes a fifty-card page open a hundred and fifty connections; loading strictly one at a time
 * makes a card at the bottom of the viewport wait for every card above it; and a library for this
 * would be a dependency for thirty lines, which `docs/supply-chain.md` asks us not to take.
 *
 * `requested` is never cleared. A card that scrolls out of view and back must not refetch: the
 * facts it is showing are the facts it had, and re-requesting them on every scroll reversal would
 * turn a bounded read into an unbounded one.
 */
export class BoundedFactLoader {
  private readonly requested = new Set<string>()
  private readonly waiting: string[] = []
  private inFlight = 0

  constructor(
    private readonly limit: number,
    private readonly onSettled: (runId: string, state: RunFactsState) => void,
  ) {}

  /** Ask for a run's facts. Idempotent: a key that is queued, loading or loaded is ignored. */
  request(runId: string): void {
    if (this.requested.has(runId)) return
    this.requested.add(runId)
    this.waiting.push(runId)
    this.pump()
  }

  /** Forget a failed key so a retry can ask again. */
  forget(runId: string): void {
    this.requested.delete(runId)
  }

  private pump(): void {
    while (this.inFlight < this.limit) {
      const next = this.waiting.shift()
      if (next === undefined) return
      this.inFlight += 1
      void loadRunFacts(next)
        .then((outcome) => {
          this.onSettled(
            next,
            outcome.ok
              ? { kind: 'ready', facts: outcome.value }
              : { kind: 'error', message: outcome.message },
          )
        })
        .finally(() => {
          this.inFlight -= 1
          this.pump()
        })
    }
  }
}

/** Three at a time: enough that a viewport fills promptly, few enough that nothing stampedes. */
export const FACT_LOAD_CONCURRENCY = 3
