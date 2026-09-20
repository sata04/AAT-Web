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
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { type Database, rowsAffected } from '../db/client.ts'
import { cloudObjects, quotaReservations, quotaUsage, runs } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'

/*
 * Claim-correlated settlement.
 *
 * Every quota transition is a claim followed by a ledger write. Running them as two loose
 * statements leaves a hole: the claim commits, the ledger write fails, and the settled marker
 * is what a retry would have used to know the write was still owed — so the bytes leak
 * permanently. The two therefore go in one `db.batch`, with the ledger write correlated to a
 * unique `claim_token` the claim just wrote: the pair is atomic, and a claim a concurrent
 * caller already won makes the whole batch a no-op rather than a second decrement.
 *
 * `claim_token` on quota_reservations and `settled_claim` on cloud_objects are those markers.
 */
const claimedBy = (reservationId: string, token: string) =>
  sql`EXISTS (SELECT 1 FROM quota_reservations WHERE id = ${reservationId} AND claim_token = ${token})`

/** Lowercase hex of an R2 checksum ArrayBuffer, matching the `sha256` column's format. */
function checksumHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

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
 * All three writes ride in one batch correlated to the claim's token: the pending→finalised
 * transition, the usage charge it implies, and the release of the reservation's hold on
 * `bytesReserved`. Atomicity is what makes the ordering honest — an observer sees either
 * `pending` with no charge or `finalised` with it, never `finalised` ahead of the charge it
 * implies, and never a charge whose claim rolled back. A lost claim means no ledger writes at
 * all, so there is nothing to uncharge. Returns false if the reservation had already been
 * settled.
 */
export async function finaliseReservation(
  db: Database,
  reservation: Reservation,
  actualBytes: number,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const token = newId()
  const [claimed] = await db.batch([
    db
      .update(quotaReservations)
      .set({ status: 'finalised', claimToken: token })
      .where(and(eq(quotaReservations.id, reservation.id), eq(quotaReservations.status, 'pending'))),
    // Both ledger writes are correlated to the claim: a sweeper's or deleter's winning claim
    // already released `bytesReserved`, and charging usage for bytes this caller will now roll
    // back would charge for storage that does not exist.
    db
      .update(quotaUsage)
      .set({
        bytesUsed: sql`${quotaUsage.bytesUsed} + ${actualBytes}`,
        objectCount: sql`${quotaUsage.objectCount} + 1`,
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
        updatedAt: now,
      })
      .where(and(eq(quotaUsage.userId, userId), claimedBy(reservation.id, token))),
  ])
  return rowsAffected(claimed) === 1
}

/** Give a reservation back. Safe to call on an already-settled reservation. */
export async function releaseReservation(
  db: Database,
  reservation: Reservation,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const token = newId()
  // Claim and release atomically: the decrement is correlated to the token the claim writes,
  // so a reservation someone else settled contributes nothing here.
  await db.batch([
    db
      .update(quotaReservations)
      .set({ status: 'released', claimToken: token })
      .where(and(eq(quotaReservations.id, reservation.id), eq(quotaReservations.status, 'pending'))),
    db
      .update(quotaUsage)
      .set({
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
        updatedAt: now,
      })
      .where(and(eq(quotaUsage.userId, userId), claimedBy(reservation.id, token))),
  ])
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
 *
 * This runs BEFORE the object's tombstone in the delete loops, which inverts the old order
 * deliberately: every settlement write is self-claiming and once-only, so a delete that fails
 * after settlement still converges on retry — the settlement no-ops and the tombstone lands. The
 * previous order (tombstone, then release) made a release failure permanent, because a retried
 * delete could no longer see the tombstoned object.
 */
export async function releaseObjectAccounting(
  db: Database,
  object: {
    id: string
    r2Key: string
    ownerUserId: string
    byteSize: number
    reservationId: string | null
  },
  now: Date = new Date(),
): Promise<void> {
  const token = newId()

  // Rows committed before `reservation_id` existed have NULL — those bytes were always charged,
  // and there is no reservation row to carry the claim, so the object itself carries it: the
  // `settled_claim` write is the once-only marker a retry or a racing delete consults.
  if (object.reservationId === null) {
    await db.batch([
      db
        .update(cloudObjects)
        .set({ settledClaim: token })
        .where(and(eq(cloudObjects.id, object.id), isNull(cloudObjects.settledClaim))),
      db
        .update(quotaUsage)
        .set({
          bytesUsed: sql`MAX(${quotaUsage.bytesUsed} - ${object.byteSize}, 0)`,
          objectCount: sql`MAX(${quotaUsage.objectCount} - 1, 0)`,
          updatedAt: now,
        })
        .where(
          and(
            eq(quotaUsage.userId, object.ownerUserId),
            sql`EXISTS (SELECT 1 FROM cloud_objects WHERE id = ${object.id} AND settled_claim = ${token})`,
          ),
        ),
    ])
    return
  }

  // The reservation's bytes are fixed at insert, so the amount the pending-path release owes is
  // readable before the batch; the claims inside remain conditional on the row's *current* status.
  const [reservation] = await db
    .select({ bytes: quotaReservations.bytes })
    .from(quotaReservations)
    .where(eq(quotaReservations.id, object.reservationId))
    .limit(1)
  if (reservation === undefined) return

  const rid = object.reservationId
  await db.batch([
    // A reservation still open belongs to an upload that never charged usage — its release comes
    // out of `bytesReserved`.
    db
      .update(quotaReservations)
      .set({ status: 'released', claimToken: token })
      .where(and(eq(quotaReservations.id, rid), eq(quotaReservations.status, 'pending'))),
    // `finalised` is the only state that ever incremented usage; `settled` is its released twin,
    // distinct from `released` so a never-charged hold and a charged-then-released usage are not
    // confusable on a retry.
    db
      .update(quotaReservations)
      .set({ status: 'settled', claimToken: token })
      .where(and(eq(quotaReservations.id, rid), eq(quotaReservations.status, 'finalised'))),
    db
      .update(quotaUsage)
      .set({
        bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${reservation.bytes}, 0)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(quotaUsage.userId, object.ownerUserId),
          sql`EXISTS (SELECT 1 FROM quota_reservations WHERE id = ${rid} AND claim_token = ${token} AND status = 'released')`,
        ),
      ),
    db
      .update(quotaUsage)
      .set({
        bytesUsed: sql`MAX(${quotaUsage.bytesUsed} - ${object.byteSize}, 0)`,
        objectCount: sql`MAX(${quotaUsage.objectCount} - 1, 0)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(quotaUsage.userId, object.ownerUserId),
          sql`EXISTS (SELECT 1 FROM quota_reservations WHERE id = ${rid} AND claim_token = ${token} AND status = 'settled')`,
        ),
      ),
  ])
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

/**
 * Undo an object whose upload committed but whose bookkeeping did not.
 *
 * Handlers have statements after `commitUploadedObject` — the figure row, the snapshot pointer,
 * the audit entry — that can still fail. Releasing the reservation there is already a no-op: the
 * charge settled. Without this unwind the object row, the R2 bytes and the quota charge all
 * survive, and because every upload key is deterministic the `cloud_objects_r2_key_unique`
 * constraint then refuses the retry itself — the upload is permanently wedged, not just leaked.
 *
 * `releaseObjectAccounting` covers whatever state the commit reached — a still-pending
 * reservation, a finalised charge — exactly once, so the unwind is safe to re-run after a crash
 * mid-cleanup.
 *
 * The row is deleted BEFORE the bucket object, and the bucket delete is gated on having won the
 * row, because the unique index on `r2_key` makes the row the claim ticket: a retry that finds a
 * dead row (`evictDeadObject`) removes it and re-puts its own bytes, and that re-put must never be
 * reachable by this unwind's bucket delete. If the row is already gone the unwind is over — the
 * bytes at the key now belong to whoever took the key. The sha256 guard then narrows the
 * delete to the bytes this object actually wrote: a different-sha256 retry that raced the row
 * delete leaves its put intact. (A byte-identical retry landing inside the head→delete gap is the
 * residual window; it is uncloseable without a conditional delete R2 does not offer, and bounded
 * by the re-put the recovery path performs.)
 */
export async function unwindUploadedObject(
  db: Database,
  bucket: R2Bucket,
  object: {
    id: string
    r2Key: string
    sha256: string
    ownerUserId: string
    byteSize: number
    reservationId: string
  },
  now: Date = new Date(),
): Promise<void> {
  await releaseObjectAccounting(db, object, now)
  const removed = await db.delete(cloudObjects).where(eq(cloudObjects.id, object.id))
  if (rowsAffected(removed) !== 1) return
  const head = await bucket.head(object.r2Key)
  if (head?.checksums.sha256 && checksumHex(head.checksums.sha256) === object.sha256) {
    await bucket.delete(object.r2Key)
  }
}

/**
 * Finish the cleanup of an object whose accounting is terminal but whose row still occupies a
 * deterministic key — the state an unwind dies in.
 *
 * "Dead" has to be provable from the row alone, because the only actor who ever calls this is a
 * stranger: a later upload that needs the key. `settled_claim` set, a reservation released or
 * settled, or a reservation row gone entirely all mean no one can still be committing it. A
 * `finalised` reservation is deliberately NOT dead — it is the steady state of every committed
 * object, and its `expires_at` lapses while the object lives legitimately, so expiry cannot
 * separate a crashed unwind from a live record.
 *
 * R2 is never touched here: the caller got to this row because its own put already wrote the key,
 * so the bytes present are the caller's, not the dead row's.
 *
 * Returns whether the key is free — true when no row existed or the row was dead and removed.
 */
export async function evictDeadObject(db: Database, r2Key: string, now: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.r2Key, r2Key), isNull(cloudObjects.deletedAt)))
    .limit(1)
  if (!row) return true

  let dead = row.settledClaim !== null
  if (!dead && row.reservationId !== null) {
    const [reservation] = await db
      .select({ status: quotaReservations.status })
      .from(quotaReservations)
      .where(eq(quotaReservations.id, row.reservationId))
      .limit(1)
    dead = reservation === undefined || reservation.status === 'released' || reservation.status === 'settled'
  }
  if (!dead) return false

  // Accounting first, row second — the same order unwindUploadedObject uses, so whoever removes
  // the row is always the last writer the key sees.
  await releaseObjectAccounting(db, row, now)
  await db.delete(cloudObjects).where(eq(cloudObjects.id, row.id))
  return true
}

export interface SweepResult {
  reservationsReleased: number
  orphanedObjectsDeleted: number
  deadRowsReclaimed: number
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
    const token = newId()
    const [claimed] = await db.batch([
      db
        .update(quotaReservations)
        .set({ status: 'released', claimToken: token })
        .where(and(eq(quotaReservations.id, row.id), eq(quotaReservations.status, 'pending'))),
      db
        .update(quotaUsage)
        .set({
          bytesReserved: sql`MAX(${quotaUsage.bytesReserved} - ${row.bytes}, 0)`,
          updatedAt: now,
        })
        .where(and(eq(quotaUsage.userId, row.userId), claimedBy(row.id, token))),
    ])
    if (rowsAffected(claimed) !== 1) continue
    reservationsReleased++

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

  // Rows whose accounting is terminal but which still occupy their deterministic key — what an
  // unwind that dies between `releaseObjectAccounting` and its row delete leaves behind. The
  // predicate is the one `evictDeadObject` uses: a settled_claim marker, a released or settled
  // reservation, or a reservation row that vanished. `finalised` is deliberately not dead — it is
  // the steady state of every committed object, and its `expires_at` lapses while the object
  // lives legitimately, so expiry cannot separate a crashed unwind from a live record.
  const deadRows = await db
    .select({ object: cloudObjects })
    .from(cloudObjects)
    .leftJoin(quotaReservations, eq(quotaReservations.id, cloudObjects.reservationId))
    .where(
      and(
        isNull(cloudObjects.deletedAt),
        or(
          isNotNull(cloudObjects.settledClaim),
          inArray(quotaReservations.status, ['released', 'settled']),
          and(isNotNull(cloudObjects.reservationId), isNull(quotaReservations.id)),
        ),
      ),
    )
    .limit(limit)

  let deadRowsReclaimed = 0
  for (const { object } of deadRows) {
    // Accounting first, row second, bytes last — the order unwindUploadedObject keeps, so the
    // row's presence always gates the bucket delete.
    await releaseObjectAccounting(db, object, now)
    const removed = await db.delete(cloudObjects).where(eq(cloudObjects.id, object.id))
    if (rowsAffected(removed) !== 1) continue
    const head = await bucket.head(object.r2Key)
    if (head?.checksums.sha256 && checksumHex(head.checksums.sha256) === object.sha256) {
      await bucket.delete(object.r2Key)
    }
    deadRowsReclaimed++
  }

  return { reservationsReleased, orphanedObjectsDeleted, deadRowsReclaimed }
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
