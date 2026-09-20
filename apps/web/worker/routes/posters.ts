/**
 * Poster figures.
 *
 * Three endpoints, three different guarantees:
 *
 *  - `POST /revisions/:id/poster/auto` — **idempotent**. At most one automatic poster exists per
 *    (revision, preset version), enforced by a partial unique index in D1. Calling it again after
 *    the poster is ready returns the existing figure and renders nothing. Calling it while a
 *    render is in flight returns the in-flight figure and renders nothing.
 *  - `POST /revisions/:id/posters` — a custom figure. Not idempotent, because a researcher
 *    adjusting axes and re-rendering is asking for a different picture each time.
 *  - `POST /posters/:id/retry` — re-attempts a figure that failed, conditional on it still being
 *    in `failed`, so two retries do not both start a render.
 *
 * All three go through the same admission control: the circuit breaker, the concurrency cap, and a
 * per-user rate limit. When the renderer cannot take work the answer is POSTER_BUSY — backpressure
 * the browser retries later — never a queued job that costs container time nobody is waiting for.
 *
 * ## Rendering a colleague's revision reads it; the figure belongs to them
 *
 * Every route here resolves its revision at `read`, which under the shared-workspace policy any
 * Researcher or Admin holds for any member's work. A poster is derived from a revision and leaves
 * it untouched, so drawing one needs no more reach than looking at one — the thing that separates a
 * Viewer from a Researcher here is the `poster:generate` capability, not the resolver.
 *
 * The figure and its PNG are then recorded against the **revision's owner**: their quota is
 * charged, the R2 key sits under their id, and deleting their run reclaims the bytes. Mixed
 * ownership inside a single run would make deletion incoherent — the run's owner would delete
 * their experiment and still be storing, and paying for, half of it. Who actually asked for the
 * render is recorded in the audit log, which is where an actor belongs.
 */

import { type PosterPlotSpec, parsePosterPlotSpec, specHash } from '@aat/plot-spec'
import { ApiError, sha256Hex } from '@aat/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { resolveConfig } from '../config.ts'
import { type Database, rowsAffected } from '../db/client.ts'
import { cloudObjects, posterFigures } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import type { AppContext, AppEnv } from '../middleware/authorize.ts'
import {
  requireCapability,
  requireObjectAccess,
  requirePosterFigure,
  requireRevision,
  requireSession,
  withDatabase,
} from '../middleware/authorize.ts'
import { validate } from '../middleware/validate.ts'
import { writeAuditLog } from '../services/audit.ts'
import {
  assertRenderCapacity,
  claimForRender,
  markFailed,
  markRendered,
  type RenderOutcome,
  renderViaContainer,
  takeOverStaleRender,
} from '../services/poster.ts'
import {
  commitUploadedObject,
  ensureQuotaRow,
  insertObjectRowClaimingKey,
  type Reservation,
  releaseReservation,
  reserveQuota,
  unwindUploadedObject,
} from '../services/quota.ts'
import { consumeRateLimit, RATE_LIMITS, rateLimitKey } from '../services/rate-limit.ts'
import { posterKey, streamObject } from '../services/storage.ts'

export const posterRoutes = new Hono<AppEnv>()

posterRoutes.use('*', withDatabase, requireSession)

const posterRequestSchema = z.object({ spec: z.unknown() })

function figureResponse(figure: typeof posterFigures.$inferSelect) {
  return {
    posterId: figure.id,
    analysisRevisionId: figure.analysisRevisionId,
    kind: figure.kind,
    presetVersion: figure.presetVersion,
    specHash: figure.specHash,
    status: figure.status,
    rendererVersion: figure.rendererVersion,
    failureCode: figure.errorCode,
    attemptCount: figure.attemptCount,
    createdAt: figure.createdAt.toISOString(),
  }
}

/**
 * Validate the submitted spec against @aat/plot-spec.
 *
 * This is the only thing the renderer will ever be sent, and it is validated here rather than
 * trusted: the container parses JSON with Matplotlib behind it, and the spec schema — bounded
 * point counts, bounded payload bytes, finite coordinates, no control characters in the title — is
 * what stops a hostile body from becoming a rendering problem.
 */
function validateSpec(raw: unknown, revisionId: string, expectedKind: 'auto' | 'custom'): PosterPlotSpec {
  let spec: PosterPlotSpec
  try {
    spec = parsePosterPlotSpec(raw)
  } catch (error) {
    throw new ApiError('INVALID_ANALYSIS_CONFIG', { details: { reason: 'invalid_plot_spec' }, cause: error })
  }
  if (spec.analysisRevisionId !== revisionId) {
    // The spec names the revision it draws. Letting them differ would file a figure of one
    // measurement under another, which is a provenance failure, not a formatting one.
    throw new ApiError('INVALID_ANALYSIS_CONFIG', { details: { reason: 'revision_mismatch' } })
  }
  if (spec.posterKind !== expectedKind) {
    throw new ApiError('INVALID_ANALYSIS_CONFIG', { details: { reason: 'poster_kind_mismatch' } })
  }
  return spec
}

/**
 * Everything a claimed render attempt needs to publish — the row it owns while it runs, the
 * revision it draws, and the claim token every transition it makes is gated on.
 */
interface RenderWork {
  figureId: string
  attempt: string
  revision: { id: string; runId: string; ownerUserId: string }
}

/**
 * True while `attempt` still owns the figure — false once a stale-render takeover has replaced
 * the token, which is the only signal a superseded attempt ever gets.
 */
async function attemptOwnsFigure(db: Database, figureId: string, attempt: string): Promise<boolean> {
  const [figure] = await db
    .select({ renderAttempt: posterFigures.renderAttempt })
    .from(posterFigures)
    .where(eq(posterFigures.id, figureId))
    .limit(1)
  return figure?.renderAttempt === attempt
}

/**
 * The stored object's identity — everything unwindUploadedObject needs to take it back.
 */
interface StoredObject {
  id: string
  byteSize: number
  sha256: string
}

/**
 * Claim the key, write the PNG, and settle the reservation — all inside the rollback-able
 * section. Returns null when the attempt was superseded while rendering: the row just inserted is
 * unwound and nothing is put, since R2 has no conditional write and the key now belongs to the
 * takeover. Any failure unwinds the object before propagating, so the caller only ever sees a
 * committed object or an error — never a remnant.
 */
async function storePosterObject(
  context: AppContext,
  outcome: RenderOutcome,
  work: RenderWork & { key: string; reservation: Reservation },
  now: Date,
): Promise<StoredObject | null> {
  const db = context.get('db')
  const { figureId, attempt, revision, reservation, key } = work
  const ownerUserId = revision.ownerUserId

  const stored: StoredObject = {
    id: newId(),
    // Provisional until R2 reports what it stored — corrected below before the commit.
    byteSize: outcome.png.length,
    sha256: await sha256Hex(outcome.png),
  }
  const unwind = () =>
    unwindUploadedObject(
      db,
      context.env.AAT_OBJECTS,
      { ...stored, r2Key: key, ownerUserId, reservationId: reservation.id },
      now,
    )

  try {
    // The row claims the deterministic key BEFORE the bytes are written — the same ordering as the
    // snapshot path — so a second render that finishes cannot put over the winner's checksum.
    await insertObjectRowClaimingKey(
      db,
      key,
      {
        id: stored.id,
        ownerUserId,
        kind: 'poster',
        r2Key: key,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        contentType: 'image/png',
        originalFilename: null,
        runId: revision.runId,
        analysisRevisionId: revision.id,
        reservationId: reservation.id,
        createdAt: now,
      },
      now,
    )

    // A takeover while this attempt was rendering replaced the figure's render_attempt: this
    // attempt is stale, and the ownership check BEFORE putting is the only thing keeping its
    // old-spec bytes from the key the new attempt is about to claim.
    if (!(await attemptOwnsFigure(db, figureId, attempt))) {
      await unwind()
      return null
    }

    const put = await context.env.AAT_OBJECTS.put(key, outcome.png as ArrayBufferView, {
      httpMetadata: { contentType: 'image/png' },
      sha256: stored.sha256,
      customMetadata: { revisionId: revision.id, posterId: figureId, ownerUserId },
    })
    const actualBytes = put?.size ?? outcome.png.length
    if (actualBytes !== stored.byteSize) {
      await db.update(cloudObjects).set({ byteSize: actualBytes }).where(eq(cloudObjects.id, stored.id))
      stored.byteSize = actualBytes
    }
    await commitUploadedObject(
      db,
      context.env.AAT_OBJECTS,
      { id: stored.id, r2Key: key, ownerUserId, byteSize: actualBytes },
      reservation,
      revision.runId,
      now,
    )
    return stored
  } catch (error) {
    // Cleanup failure must not replace the error the request actually died of — a remnant it
    // leaves is reclaimable by the next contender for the key or the sweeper.
    await unwind().catch(() => {})
    throw error
  }
}

/**
 * Audit the render and publish it on the figure — the committed boundary. Returns false when the
 * figure was superseded: this attempt's object is unwound, since the figure now belongs to a
 * render whose bytes these are not.
 *
 * The audit entry is written BEFORE the publish, still inside the rollback-able section: if it
 * fails, the object unwinds and the attempt-gated failure mark leaves the figure 'failed' and
 * retryable. Written after markRendered it would strand a published figure pointing at deleted
 * bytes — a 'ready' row the retry route will never accept.
 */
async function commitPosterRender(
  context: AppContext,
  outcome: RenderOutcome,
  work: RenderWork & { key: string; reservation: Reservation },
  now: Date,
): Promise<boolean> {
  const db = context.get('db')
  const actor = context.get('actor')
  const { figureId, attempt, revision, reservation, key } = work
  const ownerUserId = revision.ownerUserId

  let uploaded: StoredObject | null = null
  try {
    const stored = await storePosterObject(context, outcome, work, now)
    if (stored === null) return false
    uploaded = stored

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'poster.render',
      targetType: 'poster_figure',
      targetId: figureId,
      targetOwnerUserId: ownerUserId,
      details: { byteSize: stored.byteSize, rendererVersion: outcome.rendererVersion },
      headers: context.req.raw.headers,
    })

    const published = await markRendered(db, figureId, stored.id, outcome.rendererVersion, attempt, now)
    if (!published) {
      // Superseded inside the narrow put→publish window: the figure's new attempt will write the
      // key itself, so this attempt's object — row, bytes and charge — goes back.
      await unwindUploadedObject(
        db,
        context.env.AAT_OBJECTS,
        { ...stored, r2Key: key, ownerUserId, reservationId: reservation.id },
        now,
      )
      return false
    }
    return true
  } catch (error) {
    // storePosterObject unwound whatever it created before throwing; only a committed object whose
    // publish or audit failed needs taking back here. A reservation that never got that far is
    // simply released — both paths are idempotent against a cleanup that already ran.
    if (uploaded === null) {
      await releaseReservation(db, reservation, ownerUserId, now).catch(() => {})
    } else {
      await unwindUploadedObject(
        db,
        context.env.AAT_OBJECTS,
        { ...uploaded, r2Key: key, ownerUserId, reservationId: reservation.id },
        now,
      ).catch(() => {})
    }
    throw error
  }
}

/**
 * Record the failed outcome on the figure.
 *
 * POSTER_BUSY is backpressure, not a failed render: the figure goes back to `queued` so a later
 * retry — or the next call to the idempotent endpoint — can pick it up.
 */
async function recordRenderFailure(
  db: Database,
  work: Pick<RenderWork, 'figureId' | 'attempt'>,
  error: unknown,
  now: Date,
): Promise<void> {
  const code = error instanceof ApiError ? error.code : 'POSTER_RENDER_FAILED'
  // Every transition is attempt-gated: a superseded render's failure must not touch the figure the
  // takeover now owns — neither to 'failed' nor back to 'queued'.
  if (code === 'POSTER_BUSY') {
    await db
      .update(posterFigures)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(posterFigures.id, work.figureId), eq(posterFigures.renderAttempt, work.attempt)))
  } else {
    await markFailed(db, work.figureId, code, work.attempt, now)
  }
}

/**
 * Render, store the PNG, and record the outcome. Never throws past the figure's status.
 *
 * `revision.ownerUserId` — not the actor — is what the storage is charged to and keyed under. See
 * the module header: the artifact lives with the run, so the account that will get the bytes back
 * when the run is deleted has to be the account they were taken from.
 */
async function performRender(context: AppContext, work: RenderWork, spec: PosterPlotSpec): Promise<Response> {
  const db = context.get('db')
  const config = resolveConfig(context.env)
  const { figureId, revision } = work
  const ownerUserId = revision.ownerUserId
  const now = new Date()

  try {
    const outcome = await renderViaContainer(context.env, spec)

    if (outcome.png.length === 0 || outcome.png.length > config.maxPosterBytes) {
      throw new ApiError('POSTER_RENDER_FAILED', { details: { reason: 'png_size_out_of_range' } })
    }

    await ensureQuotaRow(db, ownerUserId, config.defaultQuotaBytes, now)
    const key = posterKey(ownerUserId, revision.runId, revision.id, figureId)
    // The PNG's size is only known now, so the reservation is taken against the configured
    // maximum and finalised against what was actually produced.
    const reservation = await reserveQuota(
      db,
      ownerUserId,
      config.maxPosterBytes,
      'poster',
      key,
      config.reservationTtlSeconds,
      now,
    )
    const published = await commitPosterRender(context, outcome, { ...work, key, reservation }, now)

    const [figure] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
    if (!figure) throw new ApiError('INTERNAL')
    // A superseded attempt returns the live state — the takeover's render, still 'rendering' —
    // rather than pretending its own render won.
    return context.json({ poster: figureResponse(figure) }, published ? 201 : 200)
  } catch (error) {
    await recordRenderFailure(db, work, error, now)
    throw error
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The automatic poster: exactly one per (revision, preset version)                              */
/* ------------------------------------------------------------------------------------------- */

posterRoutes.post(
  '/revisions/:revisionId/poster/auto',
  requireCapability('poster:generate'),
  validate('json', posterRequestSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
    const spec = validateSpec(context.req.valid('json').spec, revision.id, 'auto')
    const now = new Date()

    await consumeRateLimit(db, rateLimitKey('posterRender', actor.userId), RATE_LIMITS.posterRender, now)

    const hash = await specHash(spec)
    const figureId = newId()

    // The claim. `ON CONFLICT DO NOTHING` against poster_figures_auto_unique means exactly one
    // caller ever creates this row, whatever the client does — two tabs, a double submit, a
    // retried request after a timeout.
    const inserted = await db
      .insert(posterFigures)
      .values({
        id: figureId,
        analysisRevisionId: revision.id,
        // The figure belongs to the measurement, not to whoever pressed the button — otherwise the
        // one automatic poster per revision would have a different owner depending on which
        // colleague happened to open the run first.
        ownerUserId: revision.ownerUserId,
        kind: 'auto',
        presetKey: 'aat-poster',
        presetVersion: spec.posterPresetVersion,
        specHash: hash,
        status: 'queued',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()

    if (rowsAffected(inserted) === 0) {
      const [existing] = await db
        .select()
        .from(posterFigures)
        .where(
          and(
            eq(posterFigures.analysisRevisionId, revision.id),
            eq(posterFigures.presetVersion, spec.posterPresetVersion),
            eq(posterFigures.kind, 'auto'),
          ),
        )
        .limit(1)
      if (!existing) throw new ApiError('INTERNAL')

      // Ready, rendering or failed: all three are answered with the existing figure and NO new
      // render. A failed figure is retried explicitly, through the retry endpoint, so that a
      // client polling this one cannot turn a persistent renderer fault into a render loop.
      const staleBefore = now.getTime() - config.renderStaleSeconds * 1000
      const isStale =
        existing.status === 'rendering' &&
        existing.startedAt !== null &&
        existing.startedAt.getTime() <= staleBefore
      if (existing.status !== 'queued' && !isStale) {
        return context.json({ poster: figureResponse(existing), created: false })
      }

      // Capacity is checked BEFORE the claim, never after: a check that ran afterwards would count
      // the row this request had just moved into `rendering` and refuse its own work. The claim
      // itself repeats the check inside its UPDATE — that is the one that holds under concurrency.
      await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)

      const claimOptions = {
        maxConcurrent: config.maxConcurrentRenders,
        staleSeconds: config.renderStaleSeconds,
        spec: { specHash: hash, presetVersion: spec.posterPresetVersion },
      }
      const attempt = isStale
        ? await takeOverStaleRender(db, existing.id, claimOptions, now)
        : await claimForRender(db, existing.id, ['queued'], claimOptions, now)
      if (attempt === null) {
        // Another request claimed it in between. There is exactly one render, and it is theirs.
        const [fresh] = await db
          .select()
          .from(posterFigures)
          .where(eq(posterFigures.id, existing.id))
          .limit(1)
        return context.json({ poster: figureResponse(fresh ?? existing), created: false })
      }
      return performRender(context, { figureId: existing.id, attempt, revision }, spec)
    }

    await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)
    const attempt = await claimForRender(db, figureId, ['queued'], {
      maxConcurrent: config.maxConcurrentRenders,
      staleSeconds: config.renderStaleSeconds,
      spec: { specHash: hash, presetVersion: spec.posterPresetVersion },
    })
    if (attempt === null) {
      const [fresh] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
      if (fresh) return context.json({ poster: figureResponse(fresh), created: false })
      throw new ApiError('POSTER_BUSY', { details: { reason: 'already_claimed' } })
    }
    return performRender(context, { figureId, attempt, revision }, spec)
  },
)

/* ------------------------------------------------------------------------------------------- */
/* Custom posters, history, retry, download                                                     */
/* ------------------------------------------------------------------------------------------- */

posterRoutes.post(
  '/revisions/:revisionId/posters',
  requireCapability('poster:generate'),
  validate('json', posterRequestSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
    const spec = validateSpec(context.req.valid('json').spec, revision.id, 'custom')
    const now = new Date()

    await consumeRateLimit(db, rateLimitKey('posterRender', actor.userId), RATE_LIMITS.posterRender, now)
    await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)

    const figureId = newId()
    const hash = await specHash(spec)
    await db.insert(posterFigures).values({
      id: figureId,
      analysisRevisionId: revision.id,
      ownerUserId: revision.ownerUserId,
      kind: 'custom',
      presetKey: 'aat-poster',
      presetVersion: spec.posterPresetVersion,
      specHash: hash,
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    const attempt = await claimForRender(db, figureId, ['queued'], {
      maxConcurrent: config.maxConcurrentRenders,
      staleSeconds: config.renderStaleSeconds,
    })
    if (attempt === null) {
      // Nothing consumes a queued custom figure — the idempotent auto row is found again by its
      // unique constraint, but this fresh id is unreachable by the next request, so leaving it
      // would strand it forever. Undo the insert before reporting the lost claim.
      await db.delete(posterFigures).where(eq(posterFigures.id, figureId))
      throw new ApiError('POSTER_BUSY', { details: { reason: 'already_claimed' } })
    }
    return performRender(context, { figureId, attempt, revision }, spec)
  },
)

posterRoutes.get('/revisions/:revisionId/posters', requireCapability('analysis:read'), async (context) => {
  const db = context.get('db')
  const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
  const figures = await db
    .select()
    .from(posterFigures)
    .where(eq(posterFigures.analysisRevisionId, revision.id))
    .orderBy(desc(posterFigures.id))
    .limit(100)
  return context.json({ posters: figures.map(figureResponse) })
})

posterRoutes.post(
  '/posters/:posterId/retry',
  requireCapability('poster:generate'),
  validate('json', posterRequestSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    const now = new Date()

    // One statement resolves the figure, the revision it draws and the liveness of their run, so
    // the deleted-run filter cannot be applied to one and forgotten on the other.
    const { figure, revision } = await requirePosterFigure(context, context.req.param('posterId'), 'read')
    const spec = validateSpec(
      context.req.valid('json').spec,
      revision.id,
      figure.kind === 'auto' ? 'auto' : 'custom',
    )

    await consumeRateLimit(db, rateLimitKey('posterRender', actor.userId), RATE_LIMITS.posterRender, now)
    await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)

    // Only a failed or queued figure may be retried, and only by the caller that wins this
    // transition — so a user hammering "retry" starts one render, not five. The retry's spec is
    // the caller's, not necessarily the one the figure was created with, so the claim writes its
    // hash onto the row: `specHash` must always describe the render that produced the PNG.
    const attempt = await claimForRender(db, figure.id, ['failed', 'queued'], {
      maxConcurrent: config.maxConcurrentRenders,
      staleSeconds: config.renderStaleSeconds,
      spec: { specHash: await specHash(spec), presetVersion: spec.posterPresetVersion },
    })
    if (attempt === null) {
      throw new ApiError('POSTER_BUSY', { details: { reason: 'not_retryable' } })
    }

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'poster.retry',
      targetType: 'poster_figure',
      targetId: figure.id,
      targetOwnerUserId: figure.ownerUserId,
      headers: context.req.raw.headers,
    })

    return performRender(context, { figureId: figure.id, attempt, revision }, spec)
  },
)

posterRoutes.get('/posters/:posterId/image', requireCapability('cloud:read'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')

  const { figure } = await requirePosterFigure(context, context.req.param('posterId'), 'read')
  if (figure.status !== 'ready' || !figure.objectId) throw new ApiError('RESOURCE_NOT_FOUND')

  const [record] = await db
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.id, figure.objectId), isNull(cloudObjects.deletedAt)))
    .limit(1)
  if (!record) throw new ApiError('RESOURCE_NOT_FOUND')
  requireObjectAccess(context, record.ownerUserId, 'read')

  const object = await context.env.AAT_OBJECTS.get(record.r2Key)
  if (!object) throw new ApiError('RESOURCE_NOT_FOUND')

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'poster.download',
    targetType: 'poster_figure',
    targetId: figure.id,
    targetOwnerUserId: figure.ownerUserId,
    headers: context.req.raw.headers,
  })

  return streamObject(object, 'image/png')
})
