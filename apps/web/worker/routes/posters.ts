/**
 * Poster figures.
 *
 * The renderer is gone: the browser draws the PNG itself — Pyodide + Matplotlib in WASM — and
 * POSTs it. The Worker no longer renders anything; it validates the upload, stores it in R2 and
 * records a `poster_figures` row already `ready`.
 *
 * Two write endpoints, two different guarantees:
 *
 *  - `POST /revisions/:id/poster/auto` — **idempotent**. At most one automatic poster exists per
 *    (revision, preset version), enforced by a partial unique index in D1. Calling it again after
 *    the poster is recorded returns the existing figure and stores nothing.
 *  - `POST /revisions/:id/posters` — a custom figure. Not idempotent, because a researcher
 *    adjusting axes and re-rendering is asking for a different picture each time.
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
 * their experiment and still be storing, and paying for, half of it. Who actually uploaded is
 * recorded in the audit log, which is where an actor belongs.
 */

import { type PosterPlotSpec, parsePosterPlotSpec, specHash } from '@aat/plot-spec'
import { ApiError } from '@aat/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { resolveConfig } from '../config.ts'
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
  decodePosterPng,
  findAutoPosterFigure,
  insertPosterFigure,
  type StoredPosterObject,
  storePosterPng,
} from '../services/poster.ts'
import { unwindUploadedObject } from '../services/quota.ts'
import { streamObject } from '../services/storage.ts'

export const posterRoutes = new Hono<AppEnv>()

posterRoutes.use('*', withDatabase, requireSession)

const posterRequestSchema = z.object({
  spec: z.unknown(),
  pngBase64: z.string(),
  // The client-side drawing engine's version string ("pyodide-0.28.x/matplotlib-3.x.y"),
  // recorded on the figure as `rendererVersion` — provenance, not a value the Worker acts on.
  engineVersion: z.string().max(200).optional(),
})

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
 * The spec is what the client drew from, and it is validated here rather than trusted: the PNG
 * and the figure row are recorded against the revision the spec names, so a spec that names a
 * different revision — or was never a legal plot spec — would file a figure under provenance it
 * does not describe.
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

interface UploadBody {
  spec: PosterPlotSpec
  pngBase64: string
  engineVersion?: string | undefined
}

/**
 * Record one uploaded PNG as a figure row — the sequence both POST routes share.
 *
 * The audit entry is written BEFORE the figure insert, still inside the unwind-able section: the
 * order a committed row can never violate is "figure exists but its upload was never logged". A
 * request that then loses the auto-figure race still has its row — it describes an upload that was
 * genuinely made and discarded, which is what happened.
 *
 * Returns the stored object and how many figure rows the insert wrote (0 = the auto slot was
 * already taken).
 */
async function recordPosterUpload(
  context: AppContext,
  revision: { id: string; runId: string; ownerUserId: string },
  body: UploadBody,
  kind: 'auto' | 'custom',
  now: Date,
): Promise<{ stored: StoredPosterObject; inserted: number; figureId: string }> {
  const db = context.get('db')
  const actor = context.get('actor')
  const config = resolveConfig(context.env)

  const png = await decodePosterPng(body.pngBase64, config.maxPosterBytes)
  const hash = await specHash(body.spec)
  const figureId = newId()

  const stored = await storePosterPng(db, context.env.AAT_OBJECTS, config, { figureId, revision, png }, now)

  try {
    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'poster.upload',
      targetType: 'poster_figure',
      targetId: figureId,
      targetOwnerUserId: revision.ownerUserId,
      details: { byteSize: stored.byteSize, engineVersion: body.engineVersion ?? null },
      headers: context.req.raw.headers,
    })

    const inserted = await insertPosterFigure(db, {
      id: figureId,
      analysisRevisionId: revision.id,
      // The figure belongs to the measurement, not to whoever pressed the button — otherwise the
      // one automatic poster per revision would have a different owner depending on which
      // colleague happened to open the run first.
      ownerUserId: revision.ownerUserId,
      kind,
      presetKey: 'aat-poster',
      presetVersion: body.spec.posterPresetVersion,
      specHash: hash,
      rendererVersion: body.engineVersion ?? null,
      // The PNG arrived already drawn: there is no queue to wait in and nothing to fail at, so a
      // new row is only ever 'ready' and the attempt columns describe the upload itself.
      status: 'ready',
      objectId: stored.id,
      attemptCount: 1,
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    return { stored, inserted, figureId }
  } catch (error) {
    // Everything after the reservation is the unwind-able section: an audit or insert failure
    // takes the object — row, bytes and charge — back with it.
    await unwindUploadedObject(db, context.env.AAT_OBJECTS, stored, now).catch(() => {})
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
    const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
    const body = context.req.valid('json')
    const spec = validateSpec(body.spec, revision.id, 'auto')
    const now = new Date()

    // `ON CONFLICT DO NOTHING` against poster_figures_auto_unique means exactly one caller ever
    // creates this row, whatever the client does — two tabs, a double submit, a retried request
    // after a timeout. The read first is the fast path that keeps a repeat call from uploading at
    // all; the constraint is what still holds when two requests both miss it.
    const existing = await findAutoPosterFigure(db, revision.id, spec.posterPresetVersion)
    if (existing) {
      return context.json({ poster: figureResponse(existing), created: false })
    }

    const { stored, inserted, figureId } = await recordPosterUpload(
      context,
      revision,
      { ...body, spec },
      'auto',
      now,
    )

    if (inserted === 0) {
      // A concurrent upload won the slot. Our figure id is fresh, so the key below the object is
      // ours alone — unwinding it touches nothing of theirs.
      await unwindUploadedObject(db, context.env.AAT_OBJECTS, stored, now)
      const winner = await findAutoPosterFigure(db, revision.id, spec.posterPresetVersion)
      if (!winner) throw new ApiError('INTERNAL')
      return context.json({ poster: figureResponse(winner), created: false })
    }

    const [figure] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
    if (!figure) throw new ApiError('INTERNAL')
    return context.json({ poster: figureResponse(figure) }, 201)
  },
)

/* ------------------------------------------------------------------------------------------- */
/* Custom posters, history, download                                                              */
/* ------------------------------------------------------------------------------------------- */

posterRoutes.post(
  '/revisions/:revisionId/posters',
  requireCapability('poster:generate'),
  validate('json', posterRequestSchema),
  async (context) => {
    const db = context.get('db')
    const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
    const body = context.req.valid('json')
    const spec = validateSpec(body.spec, revision.id, 'custom')
    const now = new Date()

    const { stored, inserted, figureId } = await recordPosterUpload(
      context,
      revision,
      { ...body, spec },
      'custom',
      now,
    )
    if (inserted === 0) {
      // Unreachable in practice — the auto constraint does not cover kind='custom' — but if a
      // future index ever makes the insert a no-op, the object must not be left behind.
      await unwindUploadedObject(db, context.env.AAT_OBJECTS, stored, now)
      throw new ApiError('INTERNAL', { details: { reason: 'poster_insert_noop' } })
    }

    const [figure] = await db.select().from(posterFigures).where(eq(posterFigures.id, figureId)).limit(1)
    if (!figure) throw new ApiError('INTERNAL')
    return context.json({ poster: figureResponse(figure) }, 201)
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
