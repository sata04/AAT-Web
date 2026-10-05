/// <reference path="../../worker-configuration.d.ts" />

/**
 * Poster figures: validating a client-rendered PNG and recording it.
 *
 * The renderer is gone. The browser draws the figure itself — Pyodide + Matplotlib in WASM — and
 * POSTs the PNG; the Worker's job is narrowed to accepting it: decode, check it is really a PNG,
 * store it in R2 through the quota protocol, and write the `poster_figures` row that records it.
 *
 * ## Idempotency is the database's job
 *
 * The automatic poster for a revision is claimed by an `INSERT ... ON CONFLICT DO NOTHING` against
 * the partial unique index `poster_figures_auto_unique (analysis_revision_id, preset_version)
 * WHERE kind = 'auto'`. Exactly one caller inserts a row; everyone else gets zero rows affected
 * and reads back the row that already exists. A double-submitted request, a reload halfway
 * through, or the same user on two devices therefore produces one poster — and a *repeat* call
 * after it exists uploads nothing at all.
 *
 * A client-side "have I already asked for this?" check cannot provide that. This one is a
 * constraint in SQLite, so it holds even when the client is wrong.
 *
 * ## Store before recording; unwind on failure
 *
 * The figure row carries `object_id`, so the object must already exist — `cloud_objects` row
 * claiming the key, bytes in R2, reservation finalised — before the figure is inserted. Anything
 * that fails between the quota reservation and the figure insert unwinds the whole upload through
 * `unwindUploadedObject`, which is idempotent against a cleanup that already ran.
 *
 * A `poster/auto` caller that loses the figure insert unwinds its own upload the same way. Its
 * object key contains a fresh figure id, so the winner's bytes are never touched; the loss costs
 * one bounded, fully reclaimed upload and nothing else.
 */

import { ApiError, sha256Hex } from '@aat/shared'
import { and, eq } from 'drizzle-orm'
import type { WorkerConfig } from '../config.ts'
import { type Database, rowsAffected } from '../db/client.ts'
import { cloudObjects, posterFigures } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import {
  commitUploadedObject,
  ensureQuotaRow,
  insertObjectRowClaimingKey,
  reserveQuota,
  unwindUploadedObject,
} from './quota.ts'
import { posterKey } from './storage.ts'

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export interface DecodedPosterPng {
  bytes: Uint8Array
  sha256: string
}

/**
 * Decode a base64 string strictly: padding, length and alphabet all checked — `atob` alone
 * silently skips garbage, so a malformed upload must be rejected before a byte is produced.
 */
function strictBase64Decode(encoded: string): Uint8Array {
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !BASE64_PATTERN.test(encoded)) {
    throw new ApiError('INVALID_ANALYSIS_CONFIG', { details: { reason: 'invalid_png_base64' } })
  }
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Decode and validate a client-rendered PNG.
 *
 * Three checks, all before a byte is stored: the base64 must be strict, the decoded size must
 * fit `maxBytes`, and the first eight bytes must be the PNG signature. The signature is the
 * cheap proof that what was uploaded is the image the client claims it is; a browser-rendered
 * PNG never fails it, so a failure is a malformed request rather than a rendering problem.
 */
export async function decodePosterPng(pngBase64: string, maxBytes: number): Promise<DecodedPosterPng> {
  const bytes = strictBase64Decode(pngBase64)
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new ApiError('REQUEST_TOO_LARGE', { details: { maxBytes } })
  }
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new ApiError('INVALID_ANALYSIS_CONFIG', { details: { reason: 'png_signature_mismatch' } })
  }
  return { bytes, sha256: await sha256Hex(bytes) }
}

/**
 * The stored object's identity — everything `unwindUploadedObject` needs to take it back.
 */
export interface StoredPosterObject {
  id: string
  r2Key: string
  byteSize: number
  sha256: string
  ownerUserId: string
  reservationId: string
}

/**
 * Store the uploaded PNG: reserve the quota, claim the key, write the bytes, settle.
 *
 * The reservation is taken against the ACTUAL byte count, which — unlike the old render path —
 * is known before anything is written. On any failure after the reservation the partial object is
 * unwound before the error propagates, so the caller only ever sees a committed object or an
 * error, never a remnant.
 */
export async function storePosterPng(
  db: Database,
  bucket: R2Bucket,
  config: WorkerConfig,
  args: {
    figureId: string
    revision: { id: string; runId: string; ownerUserId: string }
    png: DecodedPosterPng
  },
  now: Date = new Date(),
): Promise<StoredPosterObject> {
  const { figureId, revision, png } = args
  const ownerUserId = revision.ownerUserId
  const r2Key = posterKey(ownerUserId, revision.runId, revision.id, figureId)

  await ensureQuotaRow(db, ownerUserId, config.defaultQuotaBytes, now)
  const reservation = await reserveQuota(
    db,
    ownerUserId,
    png.bytes.length,
    'poster',
    r2Key,
    config.reservationTtlSeconds,
    now,
  )

  const stored: StoredPosterObject = {
    id: newId(),
    r2Key,
    // Provisional until R2 reports what it stored — corrected below before the commit.
    byteSize: png.bytes.length,
    sha256: png.sha256,
    ownerUserId,
    reservationId: reservation.id,
  }

  try {
    // The row claims the key BEFORE the bytes are written — the same ordering as the snapshot
    // path — so a contender for the key fails its insert rather than its put, and can never leave
    // its bytes under the winner's checksum.
    await insertObjectRowClaimingKey(
      db,
      r2Key,
      {
        id: stored.id,
        ownerUserId,
        kind: 'poster',
        r2Key,
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

    const put = await bucket.put(r2Key, png.bytes as ArrayBufferView, {
      httpMetadata: { contentType: 'image/png' },
      sha256: stored.sha256,
      customMetadata: { revisionId: revision.id, posterId: figureId, ownerUserId },
    })
    const actualBytes = put?.size ?? png.bytes.length
    if (actualBytes !== stored.byteSize) {
      await db.update(cloudObjects).set({ byteSize: actualBytes }).where(eq(cloudObjects.id, stored.id))
      stored.byteSize = actualBytes
    }

    await commitUploadedObject(
      db,
      bucket,
      { id: stored.id, r2Key, ownerUserId, byteSize: actualBytes },
      reservation,
      revision.runId,
      now,
    )
    return stored
  } catch (error) {
    // Cleanup failure must not replace the error the request actually died of — a remnant it
    // leaves is reclaimable by the sweeper.
    await unwindUploadedObject(db, bucket, stored, now).catch(() => {})
    throw error
  }
}

/** The existing automatic figure for (revision, preset version), if one has been recorded. */
export async function findAutoPosterFigure(db: Database, revisionId: string, presetVersion: string) {
  const [figure] = await db
    .select()
    .from(posterFigures)
    .where(
      and(
        eq(posterFigures.analysisRevisionId, revisionId),
        eq(posterFigures.presetVersion, presetVersion),
        eq(posterFigures.kind, 'auto'),
      ),
    )
    .limit(1)
  return figure
}

/**
 * Insert the `poster_figures` row that records a committed upload.
 *
 * Returns the rows written: 0 means a concurrent request already holds the
 * (revision, preset_version) auto slot — the caller unwinds its own upload and reads back theirs.
 */
export async function insertPosterFigure(
  db: Database,
  values: typeof posterFigures.$inferInsert,
): Promise<number> {
  const inserted = await db.insert(posterFigures).values(values).onConflictDoNothing()
  return rowsAffected(inserted)
}
