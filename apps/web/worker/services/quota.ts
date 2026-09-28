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
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { type Database, rowsAffected } from '../db/client.ts'
import {
  analysisRevisions,
  cloudObjects,
  deletedAccountObjectKeys,
  quotaReservations,
  quotaUsage,
  runs,
  user,
} from '../db/schema.ts'
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

// Existing durable account marker; admin PATCH and quota updates cannot remove this barrier.
export const ACCOUNT_DELETION_REASON = 'account_deletion_in_progress'
const outsideDeletionBarrier = (userId: string) => sql`EXISTS (SELECT 1 FROM user
  WHERE user.id = ${userId} AND (user.ban_reason IS NULL OR user.ban_reason != ${ACCOUNT_DELETION_REASON}))`

/** The publication CAS must race cleanup's settled_claim in the same D1 statement. */
export const uploadedObjectIsPublishable = (objectId: string) => sql`EXISTS (
  SELECT 1 FROM cloud_objects candidate
  JOIN quota_reservations reservation ON reservation.id = candidate.reservation_id
  JOIN runs live_run ON live_run.id = candidate.run_id
  WHERE candidate.id = ${objectId} AND candidate.settled_claim IS NULL
    AND candidate.deleted_at IS NULL AND reservation.status = 'finalised'
    AND live_run.deleted_at IS NULL)`

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

  const id = newId()
  const capacity = and(
    eq(quotaUsage.userId, userId),
    outsideDeletionBarrier(userId),
    sql`${quotaUsage.bytesUsed} + ${quotaUsage.bytesReserved} + ${bytes} <= ${quotaUsage.bytesLimit}`,
  )
  // Insert and hold commit together. The second statement only charges this batch's admission;
  // a failed insert rolls back the batch, and a full account inserts no reservation at all.
  const [result] = await db.batch([
    db.insert(quotaReservations).select(
      db
        .select({
          id: sql<string>`${id}`.as('id'),
          userId: quotaUsage.userId,
          bytes: sql<number>`${bytes}`.as('bytes'),
          purpose: sql<string>`${purpose}`.as('purpose'),
          r2Key: sql<string>`${r2Key}`.as('r2_key'),
          status: sql<string>`'pending'`.as('status'),
          claimToken: sql<string | null>`NULL`.as('claim_token'),
          createdAt: sql<Date>`${Math.floor(now.getTime() / 1000)}`.as('created_at'),
          expiresAt: sql<Date>`${Math.floor(now.getTime() / 1000) + ttlSeconds}`.as('expires_at'),
        })
        .from(quotaUsage)
        .where(capacity),
    ),
    db
      .update(quotaUsage)
      .set({ bytesReserved: sql`${quotaUsage.bytesReserved} + ${bytes}`, updatedAt: now })
      .where(and(capacity, sql`EXISTS (SELECT 1 FROM quota_reservations WHERE id = ${id})`)),
  ])

  if (rowsAffected(result) !== 1) {
    const state = await getQuotaState(db, userId)
    throw new ApiError('QUOTA_EXCEEDED', {
      details: state
        ? { bytesUsed: state.bytesUsed, bytesReserved: state.bytesReserved, bytesLimit: state.bytesLimit }
        : { reason: 'no_quota_row' },
    })
  }

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
      .where(
        and(
          eq(quotaReservations.id, reservation.id),
          eq(quotaReservations.status, 'pending'),
          outsideDeletionBarrier(userId),
        ),
      ),
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
/**
 * Returns whether this call performed the once-only claim, so a deleter can count the object it
 * actually retired rather than every row it happened to walk past.
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
): Promise<boolean> {
  const token = newId()

  // Rows committed before `reservation_id` existed have NULL — those bytes were always charged,
  // and there is no reservation row to carry the claim, so the object itself carries it: the
  // `settled_claim` write is the once-only marker a retry or a racing delete consults.
  if (object.reservationId === null) {
    const [claim] = await db.batch([
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
    return rowsAffected(claim) === 1
  }

  // The reservation's bytes are fixed at insert, so the amount the pending-path release owes is
  // readable before the batch; the claims inside remain conditional on the row's *current* status.
  const [reservation] = await db
    .select({ bytes: quotaReservations.bytes })
    .from(quotaReservations)
    .where(eq(quotaReservations.id, object.reservationId))
    .limit(1)
  if (reservation === undefined) return false

  const rid = object.reservationId
  const [released, settled] = await db.batch([
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
  return rowsAffected(released) === 1 || rowsAffected(settled) === 1
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

  // A swept upload may have lost its row to a newer generation at this legacy key.
  // Only its own row permits physical cleanup; never delete merely because finalisation lost.
  const [owned] = await db
    .select()
    .from(cloudObjects)
    .where(
      and(
        eq(cloudObjects.id, object.id),
        eq(cloudObjects.r2Key, object.r2Key),
        eq(cloudObjects.reservationId, reservation.id),
      ),
    )
    .limit(1)
  if (owned) await unwindUploadedObject(db, bucket, owned, now)
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
 * charge settled. Without this unwind the object row, the R2 bytes and the quota charge survive
 * even though no published record names them. A legacy deterministic key can also block a retry.
 *
 * `releaseObjectAccounting` covers whatever state the commit reached — a still-pending
 * reservation, a finalised charge — exactly once, so the unwind is safe to re-run after a crash
 * mid-cleanup.
 *
 * Accounting marks the row as reclaimable before R2 is touched. Keep that durable record until
 * physical deletion confirms, so a transient R2 failure is retried by the sweeper. New uploads
 * must use generation-specific keys: D1 ownership checks cannot make an R2 delete conditional.
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
    reservationId: string | null
  },
  now: Date = new Date(),
): Promise<void> {
  let accountingError: unknown
  try {
    await releaseObjectAccounting(db, object, now)
  } catch (error) {
    accountingError = error
  }
  // Uploads use unique generation keys. Even if a sweep/account cascade removed this row
  // during PUT, the late writer must delete its bytes. A different legacy-key owner wins.
  const [owned] = await db.select().from(cloudObjects).where(eq(cloudObjects.r2Key, object.r2Key)).limit(1)
  if (owned && (owned.id !== object.id || owned.reservationId !== object.reservationId)) {
    if (accountingError) throw accountingError
    return
  }
  await bucket.delete(object.r2Key)
  // Keep the row if settlement failed: a later sweep still owes the accounting transition.
  if (accountingError) throw accountingError
  if (!owned) return
  await db.batch([
    // An unwind may follow failed publication bookkeeping. Only clear this object's pointer.
    db
      .update(analysisRevisions)
      .set({ snapshotObjectId: null })
      .where(eq(analysisRevisions.snapshotObjectId, object.id)),
    db.delete(cloudObjects).where(eq(cloudObjects.id, object.id)),
  ])
}

/**
 * A row holds its physical key until the sweeper confirms R2 deletion. Evicting even a dead row
 * without a bucket would discard the recovery record and let a retry race its pending cleanup.
 */
export async function evictDeadObject(
  db: Database,
  r2Key: string,
  _now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: cloudObjects.id })
    .from(cloudObjects)
    .where(eq(cloudObjects.r2Key, r2Key))
    .limit(1)
  return row === undefined
}

/** Claim the physical key before writing bytes; existing cleanup records retain ownership. */
export async function insertObjectRowClaimingKey(
  db: Database,
  _r2Key: string,
  values: typeof cloudObjects.$inferInsert,
  _now: Date = new Date(),
): Promise<void> {
  await db.insert(cloudObjects).values(values)
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
  userId?: string,
): Promise<SweepResult> {
  const stale = await db
    .select()
    .from(quotaReservations)
    .where(
      and(
        eq(quotaReservations.status, 'pending'),
        lte(quotaReservations.expiresAt, now),
        userId ? eq(quotaReservations.userId, userId) : undefined,
      ),
    )
    .limit(limit)

  let reservationsReleased = 0
  let orphanedObjectsDeleted = 0

  for (const row of stale) {
    const token = newId()
    const [claimed] = await db.batch([
      db
        .update(quotaReservations)
        .set({ status: 'released', claimToken: token })
        .where(
          and(
            eq(quotaReservations.id, row.id),
            eq(quotaReservations.status, 'pending'),
            lte(quotaReservations.expiresAt, now),
          ),
        ),
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
  }

  // A released reservation is itself the retry record when no object row was ever inserted.
  // Retain its key for delayed PUTs, rotating inspected entries so old records cannot starve new
  // cleanup. A live object at a legacy reused key always takes precedence over this reservation.
  const orphans = await db
    .select()
    .from(quotaReservations)
    .where(
      and(
        inArray(quotaReservations.status, ['released', 'settled']),
        userId ? eq(quotaReservations.userId, userId) : undefined,
        isNotNull(quotaReservations.r2Key),
        sql`NOT EXISTS (SELECT 1 FROM cloud_objects WHERE r2_key = ${quotaReservations.r2Key})`,
      ),
    )
    .orderBy(asc(quotaReservations.expiresAt))
    .limit(limit)
  for (const row of orphans) {
    if (row.r2Key && (await bucket.head(row.r2Key))) {
      const [owner] = await db
        .select({ id: cloudObjects.id })
        .from(cloudObjects)
        .where(eq(cloudObjects.r2Key, row.r2Key))
        .limit(1)
      if (!owner) {
        await bucket.delete(row.r2Key)
        orphanedObjectsDeleted++
      }
    }
    await db.update(quotaReservations).set({ expiresAt: now }).where(eq(quotaReservations.id, row.id))
  }

  /* Object state machine:
   * pending -> finalised/unpublished -> live (revision/figure pointer; source untombstone).
   * pending -> released; finalised -> settled. Both are reclaimable terminal states.
   * Expiry permits reclaiming unpublished finalised objects, but NEVER a live reference.
   * A failed unwind can leave a finalised object untouched: absence of a live reference plus
   * expiry makes that state reachable here. Legacy NULL-reservation orphans use created_at.
   * Claim the predicate again atomically; publication may have won since the SELECT.
   */
  const unreferenced = sql`(
    (${cloudObjects.kind} = 'snapshot' AND NOT EXISTS (
      SELECT 1 FROM analysis_revisions WHERE snapshot_object_id = ${cloudObjects.id})) OR
    (${cloudObjects.kind} = 'poster' AND NOT EXISTS (
      SELECT 1 FROM poster_figures WHERE object_id = ${cloudObjects.id})) OR
    (${cloudObjects.kind} = 'source' AND ${cloudObjects.deletedAt} IS NOT NULL))`
  const reclaimable = and(
    userId ? eq(cloudObjects.ownerUserId, userId) : undefined,
    // Protect non-expired writers under the barrier, including from other cleanup predicates.
    sql`NOT EXISTS (SELECT 1 FROM quota_reservations held JOIN user owner ON owner.id = held.user_id
      WHERE held.id = ${cloudObjects.reservationId} AND held.status = 'pending'
        AND held.expires_at > ${Math.floor(now.getTime() / 1000)}
        AND owner.ban_reason = ${ACCOUNT_DELETION_REASON})`,
    or(
      isNotNull(cloudObjects.settledClaim),
      sql`EXISTS (SELECT 1 FROM quota_reservations terminal WHERE terminal.id = ${cloudObjects.reservationId}
        AND terminal.status IN ('released', 'settled'))`,
      and(
        isNotNull(cloudObjects.reservationId),
        sql`NOT EXISTS (
        SELECT 1 FROM quota_reservations WHERE id = ${cloudObjects.reservationId})`,
      ),
      and(
        unreferenced,
        sql`COALESCE((SELECT expires_at FROM quota_reservations
        WHERE id = ${cloudObjects.reservationId}), ${cloudObjects.createdAt}) <= ${Math.floor(now.getTime() / 1000)}`,
      ),
    ),
  )
  const deadRows = await db
    .select({ object: cloudObjects })
    .from(cloudObjects)
    .leftJoin(quotaReservations, eq(quotaReservations.id, cloudObjects.reservationId))
    .where(reclaimable)
    .limit(limit)

  let deadRowsReclaimed = 0
  for (const { object } of deadRows) {
    const claimed = await db
      .update(cloudObjects)
      // Legacy rows use this field to claim their accounting; leave NULL until unwind settles it.
      .set({ settledClaim: object.reservationId === null ? object.settledClaim : newId() })
      .where(and(eq(cloudObjects.id, object.id), reclaimable))
    if (rowsAffected(claimed) !== 1) continue
    await unwindUploadedObject(db, bucket, object, now)
    deadRowsReclaimed++
  }

  // Account deletion copied every reserved key before cascading the reservation rows. Check
  // these globally even on a user-scoped sweep: the deleted owner cannot upload to trigger one.
  // Rotate but never discard an empty/successful check; a still-running PUT can land later.
  const deletedKeys = await db
    .select()
    .from(deletedAccountObjectKeys)
    .where(sql`NOT EXISTS (SELECT 1 FROM user WHERE id = ${deletedAccountObjectKeys.userId})`)
    .orderBy(asc(deletedAccountObjectKeys.lastCheckedAt), asc(deletedAccountObjectKeys.r2Key))
    .limit(limit)
  for (const row of deletedKeys) {
    try {
      if (await bucket.head(row.r2Key)) {
        await bucket.delete(row.r2Key)
        orphanedObjectsDeleted++
      }
    } catch {
      // Unrelated uploads need not fail on this account's cleanup. The retained key retries.
    }
    await db
      .update(deletedAccountObjectKeys)
      .set({ lastCheckedAt: now })
      .where(eq(deletedAccountObjectKeys.r2Key, row.r2Key))
  }

  return { reservationsReleased, orphanedObjectsDeleted, deadRowsReclaimed }
}

/** Change a user's ceiling without revoking capacity already admitted to uploads. */
export async function setQuotaLimit(
  db: Database,
  userId: string,
  bytesLimit: number,
  now: Date = new Date(),
): Promise<QuotaState> {
  const updated = await db
    .update(quotaUsage)
    .set({ bytesLimit, updatedAt: now })
    .where(
      and(
        eq(quotaUsage.userId, userId),
        outsideDeletionBarrier(userId),
        sql`${quotaUsage.bytesUsed} + ${quotaUsage.bytesReserved} <= ${bytesLimit}`,
      ),
    )
  const [owner] = await db
    .select({ banReason: user.banReason })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (!owner) throw new ApiError('RESOURCE_NOT_FOUND')
  if (owner.banReason === ACCOUNT_DELETION_REASON) {
    throw new ApiError('FORBIDDEN', { details: { reason: ACCOUNT_DELETION_REASON } })
  }
  const state = await getQuotaState(db, userId)
  if (!state) throw new ApiError('RESOURCE_NOT_FOUND')
  if (rowsAffected(updated) !== 1) {
    throw new ApiError('QUOTA_EXCEEDED', {
      details: {
        reason: 'limit_below_current_usage',
        bytesUsed: state.bytesUsed,
        bytesReserved: state.bytesReserved,
      },
    })
  }
  return state
}
