/// <reference path="../../worker-configuration.d.ts" />

/**
 * Poster rendering: admission control, the container call, and persistence.
 *
 * ## Idempotency is the database's job
 *
 * The automatic poster for a revision is claimed by an `INSERT ... ON CONFLICT DO NOTHING` against
 * the partial unique index `poster_figures_auto_unique (analysis_revision_id, preset_version)
 * WHERE kind = 'auto'`. Exactly one caller inserts a row; everyone else gets zero rows affected
 * and reads back the row that already exists. A double-submitted request, a reload halfway
 * through, or the same user on two devices therefore produces one poster and one render — and
 * crucially, a *repeat* call after the poster is ready does not re-render, it returns the existing
 * figure.
 *
 * A client-side "have I already asked for this?" check cannot provide that. This one is a
 * constraint in SQLite, so it holds even when the client is wrong.
 *
 * ## Backpressure, not queueing
 *
 * There is no queue and no Workflow. When the renderer is already busy — or the circuit breaker is
 * open — the endpoint answers POSTER_BUSY and the browser retries later. Spawning work that
 * outlives the request would mean paying for container time nobody is waiting for, which is the
 * failure mode a single-container deployment cannot absorb.
 */

import { and, eq, gt, inArray, sql } from 'drizzle-orm'
import { ApiError } from '@aat/shared'
import type { PosterPlotSpec } from '@aat/plot-spec'
import { type Database, rowsAffected } from '../db/client.ts'
import { posterFigures } from '../db/schema.ts'
import { getCircuitBreaker } from './flags.ts'

/** Statuses shared with @aat/plot-spec's `PosterFigureStatus`, so one vocabulary spans the system. */
export type PosterStatus = 'queued' | 'rendering' | 'ready' | 'failed'

export interface RenderOutcome {
  png: Uint8Array
  rendererVersion: string
  presetVersion: string | null
}

/**
 * Ask the container to draw a spec.
 *
 * The Durable Object stub is addressed by a fixed name: with `max_instances: 1` there is exactly
 * one renderer, and giving every request its own object id would create a fleet of Durable Objects
 * each trying to start a container.
 */
export async function renderViaContainer(env: Env, spec: PosterPlotSpec): Promise<RenderOutcome> {
  const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
  const response = await stub.fetch('http://renderer/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  })

  if (response.status === 429) {
    throw new ApiError('POSTER_BUSY', { details: { source: 'renderer' } })
  }
  if (!response.ok) {
    // The renderer's error body is an internal vocabulary (see poster-renderer/errors.py). Its
    // code is useful in a log and in `poster_figures.error_code`; it is not echoed to the client.
    let code = 'POSTER_RENDER_FAILED'
    try {
      const body = (await response.json()) as { code?: unknown }
      if (typeof body.code === 'string') code = body.code
    } catch {
      // Non-JSON error body; the status alone is what gets recorded.
    }
    throw new ApiError('POSTER_RENDER_FAILED', {
      details: { rendererStatus: response.status },
      cause: new Error(`renderer responded ${response.status} ${code}`),
    })
  }

  const png = new Uint8Array(await response.arrayBuffer())
  return {
    png,
    rendererVersion: response.headers.get('x-poster-renderer-version') ?? 'unknown',
    presetVersion: response.headers.get('x-poster-preset-version'),
  }
}

/**
 * Refuse to start a render when one is already in flight or the breaker is open.
 *
 * "In flight" counts rows in `rendering` whose `startedAt` is recent. A row left behind by a
 * Worker that was evicted mid-render would otherwise block every future render forever, so
 * anything older than `staleSeconds` is not counted — and is separately reclaimable by
 * {@link takeOverStaleRender}.
 */
export async function assertRenderCapacity(
  db: Database,
  maxConcurrent: number,
  staleSeconds: number,
  now: Date = new Date(),
): Promise<void> {
  const breaker = await getCircuitBreaker(db)
  if (breaker.open) {
    throw new ApiError('POSTER_BUSY', { details: { reason: 'renderer_disabled' } })
  }

  const staleBefore = new Date(now.getTime() - staleSeconds * 1000)
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(posterFigures)
    .where(and(eq(posterFigures.status, 'rendering'), gt(posterFigures.startedAt, staleBefore)))

  if ((row?.count ?? 0) >= maxConcurrent) {
    throw new ApiError('POSTER_BUSY', { details: { reason: 'renderer_at_capacity' } })
  }
}

/**
 * Move a figure into `rendering`, but only from a status it may legally leave.
 *
 * Conditional on the current status, so two requests that both read `queued` cannot both start a
 * render: one transitions, the other sees zero rows affected and backs off.
 */
export async function claimForRender(
  db: Database,
  posterId: string,
  fromStatuses: readonly PosterStatus[],
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .update(posterFigures)
    .set({
      status: 'rendering',
      startedAt: now,
      updatedAt: now,
      attemptCount: sql`${posterFigures.attemptCount} + 1`,
      errorCode: null,
    })
    .where(and(eq(posterFigures.id, posterId), inArray(posterFigures.status, [...fromStatuses])))
  return rowsAffected(result) === 1
}

/** Reclaim a render that has been in `rendering` past the stale threshold. */
export async function takeOverStaleRender(
  db: Database,
  posterId: string,
  staleSeconds: number,
  now: Date = new Date(),
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - staleSeconds * 1000)
  const result = await db
    .update(posterFigures)
    .set({ status: 'rendering', startedAt: now, updatedAt: now, attemptCount: sql`${posterFigures.attemptCount} + 1` })
    .where(
      and(
        eq(posterFigures.id, posterId),
        eq(posterFigures.status, 'rendering'),
        sql`${posterFigures.startedAt} <= ${Math.floor(staleBefore.getTime() / 1000)}`,
      ),
    )
  return rowsAffected(result) === 1
}

export async function markRendered(
  db: Database,
  posterId: string,
  objectId: string,
  rendererVersion: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(posterFigures)
    .set({ status: 'ready', objectId, rendererVersion, completedAt: now, updatedAt: now, errorCode: null })
    .where(eq(posterFigures.id, posterId))
}

export async function markFailed(
  db: Database,
  posterId: string,
  errorCode: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(posterFigures)
    .set({ status: 'failed', errorCode, completedAt: now, updatedAt: now })
    .where(eq(posterFigures.id, posterId))
}
