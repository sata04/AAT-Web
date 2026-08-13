/**
 * Analysis revisions and their snapshots.
 *
 * A revision is **immutable**. There is no PATCH and no PUT that replaces one: the only writes are
 * "create a revision" and "attach the snapshot it was created for". Re-analysing the same bytes
 * with the same configuration and the same engine is not a new revision — the unique index
 * `revisions_run_identity_unique` says so, and this route returns the existing revision instead of
 * minting a second identical one. Analysing with a *different* configuration is a new revision,
 * and it never overwrites the old one.
 *
 * The snapshot is the analytical record: full-resolution series, statistics, G-quality, warnings
 * and the configuration that produced them. It is validated on upload — decoded, schema-checked,
 * and cross-checked against the revision's own `sourceSha256` and `configHash` — because a
 * snapshot that does not match the revision it is filed under is worse than no snapshot at all.
 *
 * ## Who may reach whose revision
 *
 * Reads are open to the team and writes into the analytical record are not, which is why the
 * levels below are not symmetric:
 *
 * | Route                                | Level     | Why |
 * | ------------------------------------ | --------- | --- |
 * | `GET  /runs/:id/revisions`           | `read`    | Metadata about a colleague's analyses. |
 * | `GET  /revisions/:id`                | `read`    | Same, one revision deep. |
 * | `GET  /revisions/:id/snapshot`       | `read`    | The whole point: replay, statistics, Excel. |
 * | `GET  /runs/:id/source`              | `read`    | Re-analysing a colleague's raw CSV. |
 * | `POST /runs/:id/revisions`           | `own`     | Writes into somebody else's provenance chain. |
 * | `PUT  /revisions/:id/snapshot`       | `own`     | Same — the record must have one author. |
 * | `PUT  /runs/:id/source`              | `destroy` | Raw bytes, charged to and stored under the owner. |
 * | `DELETE /runs/:id/source`            | `destroy` | Deletes bytes nobody can recompute. |
 *
 * See worker/middleware/authorize.ts for what each level means and who holds it.
 */

import {
  AnalysisConfigSchema,
  ApiError,
  decodeSnapshot,
  gzipDecompress,
  SNAPSHOT_FORMAT_VERSION,
} from '@aat/shared'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { APP_VERSION, resolveConfig } from '../config.ts'
import { analysisMetrics, analysisRevisions, cloudObjects } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import type { AppEnv } from '../middleware/authorize.ts'
import {
  requireCapability,
  requireObjectAccess,
  requireRevision,
  requireRun,
  requireSession,
  withDatabase,
} from '../middleware/authorize.ts'
import { validate } from '../middleware/validate.ts'
import { writeAuditLog } from '../services/audit.ts'
import {
  ensureQuotaRow,
  finaliseReservation,
  releaseReservation,
  releaseUsage,
  reserveQuota,
  sweepStaleReservations,
} from '../services/quota.ts'
import { readBoundedBody, snapshotKey, sourceKey, streamObject } from '../services/storage.ts'

export const revisionRoutes = new Hono<AppEnv>()

revisionRoutes.use('*', withDatabase, requireSession)

/** A statistics scalar on the wire: a number, or one of @aat/shared's tags for NaN / ±Infinity / -0. */
const encodedScalarSchema = z.union([
  z.number(),
  z.literal('NaN'),
  z.literal('Infinity'),
  z.literal('-Infinity'),
  z.literal('-0'),
])

const windowStatisticsSchema = z.object({
  mean: encodedScalarSchema.nullable(),
  std: encodedScalarSchema.nullable(),
  startTime: encodedScalarSchema.nullable(),
})

const createRevisionSchema = z.object({
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  configHash: z.string().regex(/^[0-9a-f]{64}$/),
  config: AnalysisConfigSchema,
  engineVersion: z.string().min(1).max(64),
  appVersion: z.string().min(1).max(64).optional(),
  snapshotFormatVersion: z.number().int().min(1).max(SNAPSHOT_FORMAT_VERSION),
  notes: z.string().max(4000).optional(),
  metrics: z.object({
    windowSize: encodedScalarSchema,
    inner: windowStatisticsSchema,
    drag: windowStatisticsSchema,
    innerSampleCount: z.number().int().nonnegative(),
    dragSampleCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative().default(0),
    gQuality: z
      .array(
        z.object({
          windowSize: z.number(),
          innerStartTime: encodedScalarSchema.nullable(),
          innerMean: encodedScalarSchema.nullable(),
          innerStd: encodedScalarSchema.nullable(),
          dragStartTime: encodedScalarSchema.nullable(),
          dragMean: encodedScalarSchema.nullable(),
          dragStd: encodedScalarSchema.nullable(),
        }),
      )
      .max(1000)
      .optional(),
  }),
})

const snapshotQuerySchema = z.object({
  declaredBytes: z.coerce.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  format: z.enum(['json', 'json.gz']),
})

/** Scalars are stored as JSON text so the NaN / ±Infinity / -0 tags survive the round trip. */
function storeScalar(value: number | string | null): string | null {
  return value === null ? null : JSON.stringify(value)
}

function revisionResponse(revision: typeof analysisRevisions.$inferSelect) {
  return {
    id: revision.id,
    runId: revision.runId,
    revisionNumber: revision.revisionNumber,
    sourceSha256: revision.sourceSha256,
    configHash: revision.configHash,
    engineVersion: revision.engineVersion,
    appVersion: revision.appVersion,
    snapshotFormatVersion: revision.snapshotFormatVersion,
    hasSnapshot: revision.snapshotObjectId !== null,
    notes: revision.notes,
    createdAt: revision.createdAt.toISOString(),
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Creation                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Create an immutable revision of a run.
 *
 * Idempotent by analysis identity: a second call with the same source bytes, configuration and
 * engine version returns the first revision with 200 rather than creating a duplicate. That is
 * what makes a retried request — a flaky network, a double-clicked button — safe.
 *
 * `own`, and deliberately not widened by the workspace policy: a revision records who analysed a
 * measurement with which settings, and letting a colleague — or an administrator — append to
 * somebody else's run would make "whose analysis is this?" a question the provenance chain could
 * no longer answer. Reusing a colleague's data means reading their snapshot, not writing into
 * their history.
 */
revisionRoutes.post(
  '/runs/:runId/revisions',
  requireCapability('analysis:create'),
  validate('json', createRevisionSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const run = await requireRun(context, context.req.param('runId'), 'own')
    const body = context.req.valid('json')
    const now = new Date()

    const [existing] = await db
      .select()
      .from(analysisRevisions)
      .where(
        and(
          eq(analysisRevisions.runId, run.id),
          eq(analysisRevisions.sourceSha256, body.sourceSha256),
          eq(analysisRevisions.configHash, body.configHash),
          eq(analysisRevisions.engineVersion, body.engineVersion),
        ),
      )
      .limit(1)
    if (existing) {
      return context.json({ revision: revisionResponse(existing), created: false })
    }

    const id = newId()
    // The revision number is derived, not client-supplied. Two concurrent creates can compute the
    // same next number; the unique index rejects the loser, and the retry recomputes. Bounded
    // retries rather than a lock, because the contention window is a single statement wide.
    let inserted: typeof analysisRevisions.$inferSelect | undefined
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      const [aggregate] = await db
        .select({ maximum: sql<number>`COALESCE(MAX(${analysisRevisions.revisionNumber}), 0)` })
        .from(analysisRevisions)
        .where(eq(analysisRevisions.runId, run.id))
      const revisionNumber = (aggregate?.maximum ?? 0) + 1

      try {
        const rows = await db
          .insert(analysisRevisions)
          .values({
            id,
            runId: run.id,
            ownerUserId: actor.userId,
            revisionNumber,
            sourceSha256: body.sourceSha256,
            configHash: body.configHash,
            configJson: JSON.stringify(body.config),
            engineVersion: body.engineVersion,
            appVersion: body.appVersion ?? APP_VERSION,
            snapshotFormatVersion: body.snapshotFormatVersion,
            notes: body.notes ?? null,
            createdAt: now,
            createdByUserId: actor.userId,
          })
          .returning()
        inserted = rows[0]
      } catch (error) {
        // Either another request took this revision number, or another request created the same
        // analysis identity. Re-read: if the identity now exists, that request won and its
        // revision is the answer.
        const [raced] = await db
          .select()
          .from(analysisRevisions)
          .where(
            and(
              eq(analysisRevisions.runId, run.id),
              eq(analysisRevisions.sourceSha256, body.sourceSha256),
              eq(analysisRevisions.configHash, body.configHash),
              eq(analysisRevisions.engineVersion, body.engineVersion),
            ),
          )
          .limit(1)
        if (raced) return context.json({ revision: revisionResponse(raced), created: false })
        if (attempt === 2) throw error
      }
    }

    if (!inserted) throw new ApiError('INTERNAL')

    await db.insert(analysisMetrics).values({
      id: newId(),
      analysisRevisionId: inserted.id,
      innerMean: storeScalar(body.metrics.inner.mean),
      innerStd: storeScalar(body.metrics.inner.std),
      innerStartTime: storeScalar(body.metrics.inner.startTime),
      dragMean: storeScalar(body.metrics.drag.mean),
      dragStd: storeScalar(body.metrics.drag.std),
      dragStartTime: storeScalar(body.metrics.drag.startTime),
      windowSize: JSON.stringify(body.metrics.windowSize),
      innerSampleCount: body.metrics.innerSampleCount,
      dragSampleCount: body.metrics.dragSampleCount,
      warningCount: body.metrics.warningCount,
      gQualityJson: body.metrics.gQuality ? JSON.stringify(body.metrics.gQuality) : null,
      createdAt: now,
    })

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'revision.create',
      targetType: 'analysis_revision',
      targetId: inserted.id,
      targetOwnerUserId: run.ownerUserId,
      details: { runId: run.id, configHash: body.configHash, engineVersion: body.engineVersion },
      headers: context.req.raw.headers,
    })

    return context.json({ revision: revisionResponse(inserted), created: true }, 201)
  },
)

revisionRoutes.get('/runs/:runId/revisions', requireCapability('analysis:read'), async (context) => {
  const db = context.get('db')
  const run = await requireRun(context, context.req.param('runId'), 'read')
  const rows = await db
    .select()
    .from(analysisRevisions)
    .where(eq(analysisRevisions.runId, run.id))
    .orderBy(asc(analysisRevisions.revisionNumber))
  return context.json({ revisions: rows.map(revisionResponse) })
})

revisionRoutes.get('/revisions/:revisionId', requireCapability('analysis:read'), async (context) => {
  const db = context.get('db')
  const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
  const [metrics] = await db
    .select()
    .from(analysisMetrics)
    .where(eq(analysisMetrics.analysisRevisionId, revision.id))
    .limit(1)

  return context.json({
    revision: revisionResponse(revision),
    config: JSON.parse(revision.configJson) as unknown,
    metrics: metrics
      ? {
          windowSize: JSON.parse(metrics.windowSize) as unknown,
          inner: {
            mean: metrics.innerMean ? (JSON.parse(metrics.innerMean) as unknown) : null,
            std: metrics.innerStd ? (JSON.parse(metrics.innerStd) as unknown) : null,
            startTime: metrics.innerStartTime ? (JSON.parse(metrics.innerStartTime) as unknown) : null,
          },
          drag: {
            mean: metrics.dragMean ? (JSON.parse(metrics.dragMean) as unknown) : null,
            std: metrics.dragStd ? (JSON.parse(metrics.dragStd) as unknown) : null,
            startTime: metrics.dragStartTime ? (JSON.parse(metrics.dragStartTime) as unknown) : null,
          },
          innerSampleCount: metrics.innerSampleCount,
          dragSampleCount: metrics.dragSampleCount,
          warningCount: metrics.warningCount,
          gQuality: metrics.gQualityJson ? (JSON.parse(metrics.gQualityJson) as unknown) : null,
        }
      : null,
  })
})

/* ------------------------------------------------------------------------------------------- */
/* Snapshot upload and download                                                                 */
/* ------------------------------------------------------------------------------------------- */

revisionRoutes.put(
  '/revisions/:revisionId/snapshot',
  requireCapability('cloud:write'),
  validate('query', snapshotQuerySchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    // `own`: the snapshot IS the analytical record of this revision, so only the researcher whose
    // revision it is may file one. Nothing widens this level.
    const revision = await requireRevision(context, context.req.param('revisionId'), 'own')
    const query = context.req.valid('query')
    const now = new Date()

    if (query.declaredBytes > config.maxSnapshotBytes) {
      throw new ApiError('EXPORT_TOO_LARGE', { details: { maxBytes: config.maxSnapshotBytes } })
    }

    if (revision.snapshotObjectId) {
      const [current] = await db
        .select()
        .from(cloudObjects)
        .where(and(eq(cloudObjects.id, revision.snapshotObjectId), isNull(cloudObjects.deletedAt)))
        .limit(1)
      // A revision is immutable, and so is its snapshot. Re-uploading identical bytes is a retry
      // and is answered idempotently; different bytes for the same revision would mean the
      // analytical record had been rewritten, which is the thing this design exists to prevent.
      if (current && current.sha256 === query.sha256) {
        return context.json({ object: { id: current.id, byteSize: current.byteSize }, created: false })
      }
      if (current) {
        throw new ApiError('SNAPSHOT_INVALID', {
          details: { reason: 'revision_already_has_a_different_snapshot' },
        })
      }
    }

    // Opportunistic housekeeping: reclaim quota that aborted uploads are still holding. Doing it
    // here means the cleanup runs exactly when quota pressure is real.
    await sweepStaleReservations(db, context.env.AAT_OBJECTS, now)

    // Storage is charged to the owner of the run, never to whoever made the request. Here the two
    // are the same person by construction (`own` above), and it is written this way so that the
    // accounting rule is stated identically on all three upload paths rather than inferred.
    const ownerUserId = revision.ownerUserId
    await ensureQuotaRow(db, ownerUserId, config.defaultQuotaBytes, now)
    const key = snapshotKey(ownerUserId, revision.runId, revision.id, query.format)
    const reservation = await reserveQuota(
      db,
      ownerUserId,
      query.declaredBytes,
      'snapshot',
      key,
      config.reservationTtlSeconds,
      now,
    )

    try {
      // Read at most what was reserved: a client that declares 100 bytes and sends 10 MB is cut
      // off at 100 and rejected, rather than storing 10 MB against a 100-byte reservation.
      const body = await readBoundedBody(context.req.raw.body, reservation.bytes, 'QUOTA_EXCEEDED')

      if (body.sha256 !== query.sha256) {
        throw new ApiError('SNAPSHOT_INVALID', { details: { reason: 'sha256_mismatch' } })
      }

      // Decode it. A snapshot that cannot be parsed, or that belongs to a different analysis, is
      // rejected before it is stored — the alternative is discovering it at the moment a
      // researcher tries to reopen a two-year-old measurement.
      const rawJson = query.format === 'json.gz' ? await gzipDecompress(body.bytes) : body.bytes
      let snapshot: ReturnType<typeof decodeSnapshot>
      try {
        snapshot = decodeSnapshot(rawJson)
      } catch (error) {
        throw new ApiError('SNAPSHOT_INVALID', {
          details: { reason: 'malformed' },
          cause: error,
        })
      }
      if (snapshot.sourceSha256 !== revision.sourceSha256 || snapshot.configHash !== revision.configHash) {
        throw new ApiError('SNAPSHOT_INVALID', { details: { reason: 'does_not_match_revision' } })
      }

      const put = await context.env.AAT_OBJECTS.put(key, body.bytes as ArrayBufferView, {
        httpMetadata: { contentType: 'application/json' },
        // R2 verifies this itself and rejects the write on mismatch, so the stored bytes cannot
        // differ from the bytes that were hashed.
        sha256: body.sha256,
        customMetadata: { revisionId: revision.id, runId: revision.runId, ownerUserId },
      })

      // R2 is the authority on how many bytes exist, not the counter kept while reading.
      const actualBytes = put?.size ?? body.bytes.length
      if (actualBytes > reservation.bytes) {
        await context.env.AAT_OBJECTS.delete(key)
        throw new ApiError('QUOTA_EXCEEDED', { details: { reason: 'object_larger_than_reserved' } })
      }

      const objectId = newId()
      await db.insert(cloudObjects).values({
        id: objectId,
        ownerUserId,
        kind: 'snapshot',
        r2Key: key,
        byteSize: actualBytes,
        sha256: body.sha256,
        contentType: 'application/json',
        originalFilename: snapshot.originalFilename,
        runId: revision.runId,
        analysisRevisionId: revision.id,
        createdAt: now,
      })

      await finaliseReservation(db, reservation, actualBytes, ownerUserId, now)
      await db
        .update(analysisRevisions)
        .set({ snapshotObjectId: objectId })
        .where(eq(analysisRevisions.id, revision.id))

      await writeAuditLog(db, {
        actorUserId: actor.userId,
        action: 'snapshot.upload',
        targetType: 'analysis_revision',
        targetId: revision.id,
        targetOwnerUserId: ownerUserId,
        details: { byteSize: actualBytes, format: query.format },
        headers: context.req.raw.headers,
      })

      return context.json({ object: { id: objectId, byteSize: actualBytes }, created: true }, 201)
    } catch (error) {
      // Every failure path gives the reservation back — to the account it was taken from. Leaking
      // one would slowly consume a user's quota with bytes that were never stored.
      await releaseReservation(db, reservation, ownerUserId, now)
      throw error
    }
  },
)

revisionRoutes.get('/revisions/:revisionId/snapshot', requireCapability('cloud:read'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const revision = await requireRevision(context, context.req.param('revisionId'), 'read')
  if (!revision.snapshotObjectId) throw new ApiError('RESOURCE_NOT_FOUND')

  const [record] = await db
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.id, revision.snapshotObjectId), isNull(cloudObjects.deletedAt)))
    .limit(1)
  if (!record) throw new ApiError('RESOURCE_NOT_FOUND')
  // Re-asked against the object row rather than inherited from the revision: the two owners agree
  // by construction, and a check that assumes they do would be silently wrong the day they stop.
  requireObjectAccess(context, record.ownerUserId, 'read')

  const object = await context.env.AAT_OBJECTS.get(record.r2Key)
  if (!object) throw new ApiError('RESOURCE_NOT_FOUND')

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'snapshot.download',
    targetType: 'analysis_revision',
    targetId: revision.id,
    targetOwnerUserId: revision.ownerUserId,
    headers: context.req.raw.headers,
  })

  return streamObject(object, record.contentType)
})

/* ------------------------------------------------------------------------------------------- */
/* Original CSV backup — opt-in, per request                                                    */
/* ------------------------------------------------------------------------------------------- */

const sourceQuerySchema = z.object({
  declaredBytes: z.coerce.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().min(1).max(255),
})

/**
 * Back up the original CSV.
 *
 * OFF by default and not inferable: the request must carry
 * `x-aat-source-backup: requested-by-user`. Being signed in is not consent to upload raw
 * measurement data, and a client that "helpfully" uploads the source alongside every analysis is
 * the behaviour this header exists to make impossible to write by accident.
 *
 * The uploaded filename is stored as metadata and never becomes part of the R2 key.
 *
 * `destroy`, not `annotate`: this attaches raw measurement bytes to somebody else's experiment
 * and charges them for the storage. Consent to a backup of *your* CSV is not consent to a
 * colleague filing one under your name, so a Researcher reaches only their own runs here and an
 * administrator reaches the rest.
 */
revisionRoutes.put(
  '/runs/:runId/source',
  requireCapability('raw:upload'),
  validate('query', sourceQuerySchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    const run = await requireRun(context, context.req.param('runId'), 'destroy')
    const query = context.req.valid('query')
    const now = new Date()

    if (context.req.header('x-aat-source-backup') !== 'requested-by-user') {
      throw new ApiError('FORBIDDEN', { details: { reason: 'source_backup_not_requested' } })
    }
    if (query.declaredBytes > config.maxSourceBytes) {
      throw new ApiError('SOURCE_TOO_LARGE', { details: { maxBytes: config.maxSourceBytes } })
    }

    await sweepStaleReservations(db, context.env.AAT_OBJECTS, now)

    // Charged to the run's owner, not to the administrator who uploaded it: the object lives with
    // the run, and deleting the run has to give the bytes back to the account they came out of.
    const ownerUserId = run.ownerUserId
    await ensureQuotaRow(db, ownerUserId, config.defaultQuotaBytes, now)

    const objectId = newId()
    const key = sourceKey(ownerUserId, run.id, objectId)
    const reservation = await reserveQuota(
      db,
      ownerUserId,
      query.declaredBytes,
      'source',
      key,
      config.reservationTtlSeconds,
      now,
    )

    try {
      const body = await readBoundedBody(context.req.raw.body, reservation.bytes, 'SOURCE_TOO_LARGE')
      if (body.sha256 !== query.sha256) {
        throw new ApiError('INVALID_CSV', { details: { reason: 'sha256_mismatch' } })
      }

      const put = await context.env.AAT_OBJECTS.put(key, body.bytes as ArrayBufferView, {
        httpMetadata: { contentType: 'text/csv' },
        sha256: body.sha256,
        customMetadata: { runId: run.id, ownerUserId },
      })
      const actualBytes = put?.size ?? body.bytes.length

      await db.insert(cloudObjects).values({
        id: objectId,
        ownerUserId,
        kind: 'source',
        r2Key: key,
        byteSize: actualBytes,
        sha256: body.sha256,
        contentType: 'text/csv',
        // Metadata only. Never a key component — see services/storage.ts.
        originalFilename: query.filename,
        runId: run.id,
        createdAt: now,
      })
      await finaliseReservation(db, reservation, actualBytes, ownerUserId, now)

      await writeAuditLog(db, {
        actorUserId: actor.userId,
        action: 'source.upload',
        targetType: 'run',
        targetId: run.id,
        targetOwnerUserId: ownerUserId,
        details: { byteSize: actualBytes },
        headers: context.req.raw.headers,
      })

      return context.json({ object: { id: objectId, byteSize: actualBytes } }, 201)
    } catch (error) {
      await releaseReservation(db, reservation, ownerUserId, now)
      throw error
    }
  },
)

revisionRoutes.get('/runs/:runId/source', requireCapability('raw:download'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const run = await requireRun(context, context.req.param('runId'), 'read')

  const [record] = await db
    .select()
    .from(cloudObjects)
    .where(
      and(eq(cloudObjects.runId, run.id), eq(cloudObjects.kind, 'source'), isNull(cloudObjects.deletedAt)),
    )
    .limit(1)
  if (!record) throw new ApiError('RESOURCE_NOT_FOUND')
  requireObjectAccess(context, record.ownerUserId, 'read')

  const object = await context.env.AAT_OBJECTS.get(record.r2Key)
  if (!object) throw new ApiError('RESOURCE_NOT_FOUND')

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'source.download',
    targetType: 'run',
    targetId: run.id,
    targetOwnerUserId: run.ownerUserId,
    headers: context.req.raw.headers,
  })

  return streamObject(object, record.contentType, record.originalFilename ?? undefined)
})

revisionRoutes.delete('/runs/:runId/source', requireCapability('raw:delete'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const run = await requireRun(context, context.req.param('runId'), 'destroy')
  const now = new Date()

  const records = await db
    .select()
    .from(cloudObjects)
    .where(
      and(eq(cloudObjects.runId, run.id), eq(cloudObjects.kind, 'source'), isNull(cloudObjects.deletedAt)),
    )

  // Every object under a run belongs to the run's owner, and the caller has already been resolved
  // against that owner at `destroy`. Re-testing each row against the *caller* here would skip the
  // owner's objects on exactly the administrative path this route exists to serve, and would
  // leave the bytes in R2 while reporting a successful delete.
  for (const record of records) {
    await context.env.AAT_OBJECTS.delete(record.r2Key)
    await db.update(cloudObjects).set({ deletedAt: now }).where(eq(cloudObjects.id, record.id))
    await releaseUsage(db, record.ownerUserId, record.byteSize, now)
  }

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'source.delete',
    targetType: 'run',
    targetId: run.id,
    targetOwnerUserId: run.ownerUserId,
    details: { objectsDeleted: records.length },
    headers: context.req.raw.headers,
  })

  return context.json({ ok: true, objectsDeleted: records.length })
})
