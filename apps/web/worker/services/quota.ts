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
import { cloudObjects, quotaReservations, quotaUsage } from '../db/schema.ts'
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
 * Both the reservation release and the usage increment happen in one UPDATE, conditional on the
 * reservation still being pending — so a double finalise (a retry, a duplicate request) charges
 * once. Returns false if the reservation had already been settled.
 */
export async function finaliseReservation(
  db: Database,
  reservation: Reservation,
  actualBytes: number,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const claimed = await db
    .update(quotaReservations)
    .set({ status: 'finalised' })
    .where(and(eq(quotaReservations.id, reservation.id), eq(quotaReservations.status, 'pending')))
  if (rowsAffected(claimed) !== 1) return false

  await db
    .update(quotaUsage)
    .set({
      bytesUsed: sql`${quotaUsage.bytesUsed} + ${actualBytes}`,
      // Clamped at zero: a reservation swept by the stale-reservation sweeper has already been
      // subtracted, and a negative reserved column would give away free quota forever.
      bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
      objectCount: sql`${quotaUsage.objectCount} + 1`,
      updatedAt: now,
    })
    .where(eq(quotaUsage.userId, userId))

  return true
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
