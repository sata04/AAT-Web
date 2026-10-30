/// <reference path="../../worker-configuration.d.ts" />

import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import type { Database } from '../db/client.ts'
import {
  accountDeletions,
  cloudObjects,
  deletedAccountObjectKeys,
  quotaReservations,
  runs,
  session,
} from '../db/schema.ts'

export const ACCOUNT_DELETION_REASON = 'account_deletion_in_progress'

/** Tested inside the same D1 transaction that admits/finalises an upload. */
export const accountAcceptsUploads = (userId: string) => sql`EXISTS (
  SELECT 1 FROM user WHERE id = ${userId}
) AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE user_id = ${userId})`

/**
 * Close admission and retain every key before any R2 delete or user cascade. Atomic reservation
 * admission races this batch in D1: it is either included in this snapshot, or refused entirely.
 * Released/finalised reservations matter too: expiry/settlement does not cancel an outstanding PUT.
 */
export async function beginAccountDeletion(db: Database, userId: string, now = new Date()): Promise<void> {
  await db.batch([
    db.insert(accountDeletions).values({ userId, startedAt: now }).onConflictDoNothing(),
    db.delete(session).where(eq(session.userId, userId)),
    db
      .update(runs)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(runs.ownerUserId, userId), isNull(runs.deletedAt))),
    db
      .insert(deletedAccountObjectKeys)
      .select(
        db
          .select({
            r2Key: sql<string>`${quotaReservations.r2Key}`.as('r2_key'),
            userId: quotaReservations.userId,
            checkSequence: sql<number>`0`.as('check_sequence'),
          })
          .from(quotaReservations)
          .where(and(eq(quotaReservations.userId, userId), isNotNull(quotaReservations.r2Key))),
      )
      .onConflictDoNothing(),
    db
      .insert(deletedAccountObjectKeys)
      .select(
        db
          .select({
            r2Key: cloudObjects.r2Key,
            userId: cloudObjects.ownerUserId,
            checkSequence: sql<number>`0`.as('check_sequence'),
          })
          .from(cloudObjects)
          .where(eq(cloudObjects.ownerUserId, userId)),
      )
      .onConflictDoNothing(),
  ])
}

/**
 * Eager, user-scoped cleanup. Bounded pages keep each R2 multi-delete within its 1,000-key limit.
 * Failure leaves the account and durable keys intact; a DELETE retry starts this idempotent pass
 * again. Never remove the ledger entry: a PUT already in flight may recreate this exact key.
 */
export async function deleteAccountObjectBytes(
  db: Database,
  bucket: R2Bucket,
  userId: string,
): Promise<void> {
  let cursor: string | undefined
  for (;;) {
    const keys = await db
      .select({ r2Key: deletedAccountObjectKeys.r2Key })
      .from(deletedAccountObjectKeys)
      .where(
        and(
          eq(deletedAccountObjectKeys.userId, userId),
          cursor === undefined ? undefined : gt(deletedAccountObjectKeys.r2Key, cursor),
        ),
      )
      .orderBy(asc(deletedAccountObjectKeys.r2Key))
      .limit(1_000)
    if (keys.length === 0) return
    await bucket.delete(keys.map((row) => row.r2Key))
    cursor = keys[keys.length - 1]?.r2Key
  }
}

/**
 * Best-effort bounded recovery, triggered by the existing opportunistic quota sweeper on uploads
 * and by account-deletion retries. Rotate BEFORE I/O, including failures and empty keys, so a
 * permanently failing old key cannot starve later keys. A sequence rather than timestamps also
 * guarantees progress when several passes run in the same millisecond.
 */
export async function sweepDeletedAccountObjectKeys(
  db: Database,
  bucket: R2Bucket,
  limit = 20,
): Promise<number> {
  const keys = await db
    .select()
    .from(deletedAccountObjectKeys)
    .orderBy(asc(deletedAccountObjectKeys.checkSequence), asc(deletedAccountObjectKeys.r2Key))
    .limit(limit)
  if (keys.length === 0) return 0
  await db
    .update(deletedAccountObjectKeys)
    .set({
      checkSequence: sql`(SELECT COALESCE(MAX(check_sequence), 0) + 1 FROM deleted_account_object_keys)`,
    })
    .where(
      inArray(
        deletedAccountObjectKeys.r2Key,
        keys.map((row) => row.r2Key),
      ),
    )

  let deleted = 0
  for (const { r2Key } of keys) {
    try {
      if (await bucket.head(r2Key)) {
        await bucket.delete(r2Key)
        deleted++
      }
    } catch {
      // Leave the recovery record for the next pass; another account's upload can still proceed.
    }
  }
  return deleted
}
