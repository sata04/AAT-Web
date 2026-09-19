/// <reference path="../../worker-configuration.d.ts" />

/**
 * Storage quota: reserve, write, measure, finalise.
 *
 * ## The protocol
 *
 * ```
 *   reserve(declaredBytes)      conditional UPDATE; loses cleanly under concurrency
 *        │
 *        ├─ fail ──────────────► QUOTA_EXCEEDED, nothing written
 *        │
 *   write to R2                 body read with a hard cap, hashed while it is read
 *        │
 *   validate                    ACTUAL byte count and SHA-256, never Content-Length
 *        │
 *        ├─ mismatch/oversize ─► delete the object, release the reservation, fail
 *        │
 *   finalise(actualBytes)       reservation → usage, in one statement
 * ```
 *
 * ## Why a reservation at all
 *
 * Two uploads that each fit in the remaining space but do not both fit is the case a naive
 * "check then write then add" gets wrong: both read the same free space, both write, and the
 * account ends up over its limit with no single request having done anything wrong. Reserving
 * first — with a conditional UPDATE whose WHERE clause contains the limit test, so exactly one of
 * two concurrent reservations can win the last byte — makes the overrun impossible rather than
 * unlikely.
 *
 * ## Why the client's numbers are never trusted
 *
 * `Content-Length` is a header. A declared SHA-256 is a request field. Both are attacker-chosen.
 * The reservation is taken against what the client *claims*, because something has to be reserved
 * before the bytes arrive, but the account is only ever charged what was actually stored, measured
 * by counting the bytes as they were read and confirmed against `R2Object.size` afterwards. A
 * client that under-declares gets its upload rejected and its reservation released; it does not
 * get free storage.
 */

import { ApiError } from '@aat/shared'
import { and, eq, lte, sql } from 'drizzle-orm'
import { type Database, rowsAffected } from '../db/client.ts'
import { cloudObjects, quotaReservations, quotaUsage, runs } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'

export type ReservationPurpose = 'snapshot' | 'poster' | 'source'

export interface QuotaState {
  bytesUsed: number
  bytesReserved: number
  bytesLimit: number
  objectCount: number
}

/** Create the accounting row for a user on first use. Idempotent. */
export async function ensureQuotaRow(
  db: Database,
  userId: string,
  defaultLimitBytes: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(quotaUsage)
    .values({
      userId,
      bytesUsed: 0,
      bytesReserved: 0,
      bytesLimit: defaultLimitBytes,
      objectCount: 0,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: quotaUsage.userId })
}

export async function getQuotaState(db: Database, userId: string): Promise<QuotaState | null> {
  const [row] = await db.select().from(quotaUsage).where(eq(quotaUsage.userId, userId)).limit(1)
  if (!row) return null
  return {
    bytesUsed: row.bytesUsed,
    bytesReserved: row.bytesReserved,
    bytesLimit: row.bytesLimit,
    objectCount: row.objectCount,
  }
}

export interface Reservation {
  id: string
  bytes: number
  purpose: ReservationPurpose
  r2Key: string
}

/**
 * Reserve `bytes` against a user's quota.
 *
 * The whole decision is in the WHERE clause, so two concurrent reservations for the last byte
 * cannot both succeed. Throws `QUOTA_EXCEEDED` when the reservation does not fit.
 */
export async function reserveQuota(
  db: Database,
  userId: string,
  bytes: number,
  purpose: ReservationPurpose,
  r2Key: string,
  ttlSeconds: number,
  now: Date = new Date(),
): Promise<Reservation> {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new ApiError('QUOTA_EXCEEDED', { details: { reason: 'invalid_declared_size' } })
  }

  const result = await db
    .update(quotaUsage)
    .set({ bytesReserved: sql`${quotaUsage.bytesReserved} + ${bytes}`, updatedAt: now })
    .where(
      and(
        eq(quotaUsage.userId, userId),
        sql`${quotaUsage.bytesUsed} + ${quotaUsage.bytesReserved} + ${bytes} <= ${quotaUsage.bytesLimit}`,
      ),
    )

  if (rowsAffected(result) !== 1) {
    const state = await getQuotaState(db, userId)
    throw new ApiError('QUOTA_EXCEEDED', {
      details: state
        ? { bytesUsed: state.bytesUsed, bytesReserved: state.bytesReserved, bytesLimit: state.bytesLimit }
        : { reason: 'no_quota_row' },
    })
  }

  const id = newId()
  await db.insert(quotaReservations).values({
    id,
    userId,
    bytes,
    purpose,
    r2Key,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  })

  return { id, bytes, purpose, r2Key }
}

/**
 * Convert a reservation into recorded usage, charging the ACTUAL byte count.
 *
 * The charge is written before the reservation settles so a deletion never observes `finalised`
 * ahead of the charge it implies. A lost claim uncharges exactly the bytes and object count it
 * added; the reservation's hold on `bytesReserved` is released only after the claim is won, so a
 * sweeper's or deleter's subtraction can never be subtracted twice. Returns false if the
 * reservation had already been settled.
 */
export async function finaliseReservation(
  db: Database,
  reservation: Reservation,
  actualBytes: number,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  await db
    .update(quotaUsage)
    .set({
      bytesUsed: sql`${quotaUsage.bytesUsed} + ${actualBytes}`,
      objectCount: sql`${quotaUsage.objectCount} + 1`,
      updatedAt: now,
    })
    .where(eq(quotaUsage.userId, userId))

  const claimed = await db
    .update(quotaReservations)
    .set({ status: 'finalised' })
    .where(and(eq(quotaReservations.id, reservation.id), eq(quotaReservations.status, 'pending')))
  if (rowsAffected(claimed) === 1) {
    // We own the settlement, so the hold is ours to release: nobody else subtracts it now.
    // Clamped at zero in case the row drifted while the charge was in flight.
    await db
      .update(quotaUsage)
      .set({
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
        updatedAt: now,
      })
      .where(eq(quotaUsage.userId, userId))
    return true
  }

  // The claim lost to a sweeper or a deleter — both now treat the bytes as never charged — so
  // the usage charge written above is owed back. `bytesReserved` is not touched here: the winning
  // claimer released it already, and adding it back would double-count the hold.
  await db
    .update(quotaUsage)
    .set({
      bytesUsed: sql`MAX(${quotaUsage.bytesUsed} - ${actualBytes}, 0)`,
      objectCount: sql`MAX(${quotaUsage.objectCount} - 1, 0)`,
      updatedAt: now,
    })
    .where(eq(quotaUsage.userId, userId))
  return false
}

/** Give a reservation back. Safe to call on an already-settled reservation. */
export async function releaseReservation(
  db: Database,
  reservation: Reservation,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const claimed = await db
    .update(quotaReservations)
    .set({ status: 'released' })
    .where(and(eq(quotaReservations.id, reservation.id), eq(quotaReservations.status, 'pending')))
  if (rowsAffected(claimed) !== 1) return

  await db
    .update(quotaUsage)
    .set({
      bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
      updatedAt: now,
    })
    .where(eq(quotaUsage.userId, userId))
}

/** Subtract a deleted object from recorded usage. */
export async function releaseUsage(
  db: Database,
  userId: string,
  bytes: number,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(quotaUsage)
    .set({
      bytesUsed: sql`MAX(${quotaUsage.bytesUsed} - ${bytes}, 0)`,
      objectCount: sql`MAX(${quotaUsage.objectCount} - 1, 0)`,
      updatedAt: now,
    })
    .where(eq(quotaUsage.userId, userId))
}

/**
 * Release whatever accounting a deleted object still holds.
 *
 * A deleter cannot assume the object it is reclaiming ever finished uploading. The object's
 * reservation may still be `pending` — the uploader is mid-flight between writing to R2 and
 * converting its reservation — and subtracting `bytesUsed` for it would take quota away from
 * bytes that were never charged. `released` is the third state that matters: the
 * stale-reservation sweeper can claim an expired reservation while the object row is already
 * sitting there, and a released reservation charged nothing either.
 *
 * The lookup is by `reservation_id` rather than by `r2_key` because a deterministic R2 key can
 * have several historical reservation rows (a finalised one from the upload that landed plus a
 * swept one from a retry that never did); only the object's own reservation says what this row's
 * bytes were charged as.
 */
export async function releaseObjectAccounting(
  db: Database,
  object: { r2Key: string; ownerUserId: string; byteSize: number; reservationId: string | null },
  now: Date = new Date(),
): Promise<void> {
  // Rows committed before `reservation_id` existed have NULL — those bytes were always charged.
  if (object.reservationId === null) {
    await releaseUsage(db, object.ownerUserId, object.byteSize, now)
    return
  }

  // Claim the reservation only while it is still pending: a reservation that is still open belongs
  // to an upload that never charged usage, so the release comes out of `bytesReserved`.
  const claimed = await db
    .update(quotaReservations)
    .set({ status: 'released' })
    .where(and(eq(quotaReservations.id, object.reservationId), eq(quotaReservations.status, 'pending')))
    .returning({ bytes: quotaReservations.bytes })
  const [claimedReservation] = claimed
  if (claimedReservation !== undefined) {
    await db
      .update(quotaUsage)
      .set({
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${claimedReservation.bytes}, 0)`,
        updatedAt: now,
      })
      .where(eq(quotaUsage.userId, object.ownerUserId))
    return
  }

  const [reservation] = await db
    .select({ status: quotaReservations.status })
    .from(quotaReservations)
    .where(eq(quotaReservations.id, object.reservationId))
    .limit(1)
  // `finalised` is the only state that ever incremented usage. A reservation the stale-reservation
  // sweeper claimed is `released` — nothing was charged, and subtracting `bytesUsed` now would take
  // quota away from objects that still exist.
  if (reservation?.status === 'finalised') {
    await releaseUsage(db, object.ownerUserId, object.byteSize, now)
  }
}

/**
 * Commit an uploaded object: prove the run it belongs to is still alive, then convert the
 * reservation into usage.
 *
 * The liveness check runs *after* the object row exists, on purpose — the `requireRun` at the
 * top of the handler predates the body read by seconds. A run deleted while the body streamed
 * in walked its object list before this row existed, so committing anyway would leave live
 * bytes under a dead run that nothing can reach or reclaim. The run delete tombstones
 * `runs.deleted_at` *before* walking objects, so a row inserted before this read is guaranteed
 * to be inside a delete that lands later — and this read is what forces the upload to unwind
 * when it is not.
 *
 * The reservation check is the mirror image: a stale-reservation sweep or a deleter may have
 * already claimed it, in which case nothing was charged and nothing may remain. On either
 * failure the object row and the R2 bytes are rolled back before the error propagates.
 */
export async function commitUploadedObject(
  db: Database,
  bucket: R2Bucket,
  object: { id: string; r2Key: string; ownerUserId: string; byteSize: number },
  reservation: Reservation,
  runId: string,
  now: Date = new Date(),
): Promise<void> {
  const [live] = await db.select({ deletedAt: runs.deletedAt }).from(runs).where(eq(runs.id, runId)).limit(1)
  const runGone = !live || live.deletedAt !== null

  const finalised = runGone
    ? false
    : await finaliseReservation(db, reservation, object.byteSize, object.ownerUserId, now)
  if (finalised) return

  await db.delete(cloudObjects).where(eq(cloudObjects.id, object.id))
  await bucket.delete(object.r2Key)
  if (runGone) {
    // The reservation may already have been released by the deleter — releasing again is a
    // no-op on a settled row — so this is safe from either side of that race.
    await releaseReservation(db, reservation, object.ownerUserId, now)
    throw new ApiError('RESOURCE_NOT_FOUND', { details: { reason: 'run_deleted_mid_upload' } })
  }
  throw new ApiError('INTERNAL', { details: { reason: 'reservation_settled_early' } })
}

export interface SweepResult {
  reservationsReleased: number
  orphanedObjectsDeleted: number
}

/**
 * Reclaim reservations whose upload never finished, and delete the objects they orphaned.
 *
 * This is what covers the aborted upload: the client vanished mid-PUT, so nothing finalised the
 * reservation and the account would otherwise carry a phantom charge forever. An object may exist
 * in R2 for a key whose reservation is being reclaimed — it was written but never committed to
 * `cloud_objects` — and it is deleted here rather than left to be paid for silently.
 *
 * Runs opportunistically on upload paths rather than on a cron: there is no scheduled trigger in
 * this Worker, and the moment someone is uploading is exactly the moment stale reservations matter.
 */
export async function sweepStaleReservations(
  db: Database,
  bucket: R2Bucket,
  now: Date = new Date(),
  limit = 20,
): Promise<SweepResult> {
  const stale = await db
    .select()
    .from(quotaReservations)
    .where(and(eq(quotaReservations.status, 'pending'), lte(quotaReservations.expiresAt, now)))
    .limit(limit)

  let reservationsReleased = 0
  let orphanedObjectsDeleted = 0

  for (const row of stale) {
    const claimed = await db
      .update(quotaReservations)
      .set({ status: 'released' })
      .where(and(eq(quotaReservations.id, row.id), eq(quotaReservations.status, 'pending')))
    if (rowsAffected(claimed) !== 1) continue
    reservationsReleased++

    await db
      .update(quotaUsage)
      .set({
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${row.bytes}, 0)`,
        updatedAt: now,
      })
      .where(eq(quotaUsage.userId, row.userId))

    if (row.r2Key) {
      // Only delete when no committed object claims the key: a finalised upload owns its bytes,
      // and deleting those would destroy a snapshot the database still points at.
      const [committed] = await db
        .select({ id: cloudObjects.id })
        .from(cloudObjects)
        .where(eq(cloudObjects.r2Key, row.r2Key))
        .limit(1)
      if (!committed) {
        await bucket.delete(row.r2Key)
        orphanedObjectsDeleted++
      }
    }
  }

  return { reservationsReleased, orphanedObjectsDeleted }
}

/** Change a user's storage ceiling. Never lowers below what is already stored. */
export async function setQuotaLimit(
  db: Database,
  userId: string,
  bytesLimit: number,
  now: Date = new Date(),
): Promise<QuotaState> {
  const state = await getQuotaState(db, userId)
  if (!state) throw new ApiError('RESOURCE_NOT_FOUND')
  if (bytesLimit < state.bytesUsed) {
    throw new ApiError('QUOTA_EXCEEDED', {
      details: { reason: 'limit_below_current_usage', bytesUsed: state.bytesUsed },
    })
  }
  await db.update(quotaUsage).set({ bytesLimit, updatedAt: now }).where(eq(quotaUsage.userId, userId))
  return { ...state, bytesLimit }
}
