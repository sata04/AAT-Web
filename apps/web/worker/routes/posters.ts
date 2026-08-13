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
import { rowsAffected } from '../db/client.ts'
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
  renderViaContainer,
  takeOverStaleRender,
} from '../services/poster.ts'
import { ensureQuotaRow, finaliseReservation, releaseReservation, reserveQuota } from '../services/quota.ts'
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
 * Render, store the PNG, and record the outcome. Never throws past the figure's status.
 *
 * `revision.ownerUserId` — not the actor — is what the storage is charged to and keyed under. See
 * the module header: the artifact lives with the run, so the account that will get the bytes back
 * when the run is deleted has to be the account they were taken from.
 */
async function performRender(
  context: AppContext,
  figureId: string,
  spec: PosterPlotSpec,
  revision: { id: string; runId: string; ownerUserId: string },
): Promise<Response> {
  const db = context.get('db')
  const actor = context.get('actor')
  const config = resolveConfig(context.env)
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

    try {
      const digest = await sha256Hex(outcome.png)
      const put = await context.env.AAT_OBJECTS.put(key, outcome.png as ArrayBufferView, {
        httpMetadata: { contentType: 'image/png' },
        sha256: digest,
        customMetadata: { revisionId: revision.id, posterId: figureId, ownerUserId },
      })
      const actualBytes = put?.size ?? outcome.png.length

      const objectId = newId()
      await db.insert(cloudObjects).values({
        id: objectId,
        ownerUserId,
        kind: 'poster',
        r2Key: key,
        byteSize: actualBytes,
        sha256: digest,
        contentType: 'image/png',
        originalFilename: null,
        runId: revision.runId,
        analysisRevisionId: revision.id,
        createdAt: now,
      })
      await finaliseReservation(db, reservation, actualBytes, ownerUserId, now)
      await markRendered(db, figureId, objectId, outcome.rendererVersion, now)

      await writeAuditLog(db, {
        actorUserId: actor.userId,
        action: 'poster.render',
        targetType: 'poster_figure',
        targetId: figureId,
        targetOwnerUserId: ownerUserId,
        details: { byteSize: actualBytes, rendererVersion: outcome.rendererVersion },
        headers: context.req.raw.headers,
      })
    } catch (error) {
      await releaseReservation(db, reservation, ownerUserId, now)
      throw error
    }
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'POSTER_RENDER_FAILED'
    // POSTER_BUSY is backpressure, not a failed render: the figure goes back to `queued` so a
    // later retry — or the next call to the idempotent endpoint — can pick it up.
    if (code === 'POSTER_BUSY') {
      await db
        .update(posterFigures)
        .set({ status: 'queued', updatedAt: now })
        .where(eq(posterFigures.id, figureId))
    } else {
      await markFailed(db, figureId, code, now)
    }
    throw error
  }

  const [figure] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
  if (!figure) throw new ApiError('INTERNAL')
  return context.json({ poster: figureResponse(figure) }, 201)
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
      // the row this request had just moved into `rendering` and refuse its own work.
      await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)

      const claimed = isStale
        ? await takeOverStaleRender(db, existing.id, config.renderStaleSeconds, now)
        : await claimForRender(db, existing.id, ['queued'], now)
      if (!claimed) {
        // Another request claimed it in between. There is exactly one render, and it is theirs.
        const [fresh] = await db
          .select()
          .from(posterFigures)
          .where(eq(posterFigures.id, existing.id))
          .limit(1)
        return context.json({ poster: figureResponse(fresh ?? existing), created: false })
      }
      return performRender(context, existing.id, spec, revision)
    }

    await assertRenderCapacity(db, config.maxConcurrentRenders, config.renderStaleSeconds, now)
    if (!(await claimForRender(db, figureId, ['queued'], now))) {
      const [fresh] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
      if (fresh) return context.json({ poster: figureResponse(fresh), created: false })
      throw new ApiError('POSTER_BUSY', { details: { reason: 'already_claimed' } })
    }
    return performRender(context, figureId, spec, revision)
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
    await db.insert(posterFigures).values({
      id: figureId,
      analysisRevisionId: revision.id,
      ownerUserId: revision.ownerUserId,
      kind: 'custom',
      presetKey: 'aat-poster',
      presetVersion: spec.posterPresetVersion,
      specHash: await specHash(spec),
      status: 'queued',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    })

    if (!(await claimForRender(db, figureId, ['queued'], now))) {
      throw new ApiError('POSTER_BUSY', { details: { reason: 'already_claimed' } })
    }
    return performRender(context, figureId, spec, revision)
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
    // transition — so a user hammering "retry" starts one render, not five.
    if (!(await claimForRender(db, figure.id, ['failed', 'queued'], now))) {
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

    return performRender(context, figure.id, spec, revision)
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
