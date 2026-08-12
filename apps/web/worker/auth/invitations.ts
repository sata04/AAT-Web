/**
 * Invitation issue and redemption.
 *
 * AAT has no open sign-up. An administrator issues a 256-bit token; the plaintext is shown exactly
 * once and only the SHA-256 is stored, so the database — and every backup and query log derived
 * from it — contains nothing redeemable. Redemption exchanges the token for a short-lived opaque
 * *registration context*, and only that context can complete a passkey registration.
 *
 * ## The race, and how it is closed
 *
 * "Single use" is not a property of a SELECT followed by an UPDATE. Two requests carrying the same
 * token can both read `status = 'pending'` and both proceed, and D1 offers no serialisable
 * transaction to wrap them in. Every state transition here is therefore a single conditional
 * UPDATE whose WHERE clause contains the entire precondition, and the caller believes only
 * `rowsAffected === 1`:
 *
 *     UPDATE registration_invites
 *        SET status = 'claimed', ...
 *      WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
 *        AND (status = 'pending' OR (status = 'claimed' AND claim_expires_at <= ?))
 *
 * SQLite applies a statement atomically, so exactly one of two concurrent executions can observe
 * the precondition and write; the loser sees zero rows affected and is told the invitation is
 * already used. The `SELECT` that happens first exists only to produce a good error message
 * (invalid vs expired vs revoked vs used) and is never trusted for the decision.
 *
 * ## Why a claim rather than immediate consumption
 *
 * Marking the invitation used at exchange time would burn it whenever a user dismisses the
 * platform's passkey prompt — a common, blameless action that would then need an administrator to
 * issue a new invitation. Instead the exchange *claims* the invitation for a few minutes. A claim
 * that is not completed expires and the invitation returns to being redeemable; a claim that is
 * completed transitions to `used`, permanently. Either way, at most one registration context is
 * live for an invitation at a time.
 */

import { and, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { ApiError, type Role, ROLES } from '@aat/shared'
import { type Database, rowsAffected } from '../db/client.ts'
import { registrationInvites } from '../db/schema.ts'
import { hashToken, newId, newSecretToken } from '../lib/ids.ts'

export type InviteKind = 'registration' | 'recovery'

/** How long a registration context stays valid once an invitation has been claimed. */
export const CLAIM_TTL_SECONDS = 600

export interface CreateInvitationInput {
  kind: InviteKind
  role: Role
  displayName: string
  note?: string | undefined
  /** Required for `recovery`: the existing user who is regaining access. */
  targetUserId?: string | undefined
  ttlSeconds: number
  createdByUserId: string
}

export interface CreatedInvitation {
  id: string
  /**
   * The plaintext token. This is the only time it exists: it is not stored, not logged, and cannot
   * be recovered. Hand it to the administrator and forget it.
   */
  token: string
  expiresAt: Date
}

export async function createInvitation(
  db: Database,
  input: CreateInvitationInput,
  now: Date = new Date(),
): Promise<CreatedInvitation> {
  if (input.kind === 'recovery' && !input.targetUserId) {
    throw new ApiError('INVITE_INVALID', { details: { reason: 'recovery_requires_target_user' } })
  }
  if (!ROLES.includes(input.role)) {
    throw new ApiError('INVITE_INVALID', { details: { reason: 'unknown_role' } })
  }

  const token = newSecretToken()
  const id = newId()
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000)

  await db.insert(registrationInvites).values({
    id,
    tokenHash: await hashToken(token),
    kind: input.kind,
    role: input.role,
    displayName: input.displayName,
    note: input.note ?? null,
    targetUserId: input.targetUserId ?? null,
    createdByUserId: input.createdByUserId,
    createdAt: now,
    expiresAt,
    status: 'pending',
  })

  return { id, token, expiresAt }
}

export interface ClaimedInvitation {
  invitationId: string
  kind: InviteKind
  role: Role
  displayName: string
  targetUserId: string | null
  /** The plaintext registration context. Shown to the client once; stored only as a hash. */
  registrationContext: string
  contextExpiresAt: Date
}

/**
 * Exchange a token for a registration context, atomically claiming the invitation.
 *
 * Throws the taxonomy's invitation errors: `INVITE_INVALID` (unknown or revoked), `INVITE_EXPIRED`,
 * `INVITE_USED` (already spent, or lost the race to a concurrent redemption).
 */
export async function claimInvitation(
  db: Database,
  token: string,
  now: Date = new Date(),
): Promise<ClaimedInvitation> {
  const tokenHash = await hashToken(token)
  const [invitation] = await db
    .select()
    .from(registrationInvites)
    .where(eq(registrationInvites.tokenHash, tokenHash))
    .limit(1)

  // An unknown token and a revoked token are reported identically: distinguishing them would
  // confirm to a guesser that a token they invented once existed.
  if (!invitation || invitation.revokedAt !== null) {
    throw new ApiError('INVITE_INVALID')
  }
  if (invitation.usedAt !== null || invitation.status === 'used') {
    throw new ApiError('INVITE_USED')
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError('INVITE_EXPIRED')
  }

  const registrationContext = newSecretToken()
  const contextHash = await hashToken(registrationContext)
  const contextExpiresAt = new Date(now.getTime() + CLAIM_TTL_SECONDS * 1000)

  const result = await db
    .update(registrationInvites)
    .set({
      status: 'claimed',
      claimContextHash: contextHash,
      claimedAt: now,
      claimExpiresAt: contextExpiresAt,
    })
    .where(
      and(
        eq(registrationInvites.id, invitation.id),
        isNull(registrationInvites.usedAt),
        isNull(registrationInvites.revokedAt),
        sql`${registrationInvites.expiresAt} > ${Math.floor(now.getTime() / 1000)}`,
        or(
          eq(registrationInvites.status, 'pending'),
          and(
            eq(registrationInvites.status, 'claimed'),
            lte(registrationInvites.claimExpiresAt, now),
          ),
        ),
      ),
    )

  if (rowsAffected(result) !== 1) {
    // Someone else claimed it between the SELECT above and this UPDATE. There is exactly one
    // winner and this caller is not it.
    throw new ApiError('INVITE_USED')
  }

  const role = ROLES.includes(invitation.role as Role) ? (invitation.role as Role) : 'Viewer'

  return {
    invitationId: invitation.id,
    kind: invitation.kind === 'recovery' ? 'recovery' : 'registration',
    role,
    displayName: invitation.displayName,
    targetUserId: invitation.targetUserId,
    registrationContext,
    contextExpiresAt,
  }
}

export interface ResolvedContext {
  invitationId: string
  kind: InviteKind
  role: Role
  displayName: string
  targetUserId: string | null
}

/**
 * Resolve a registration context back to its invitation, without consuming anything.
 *
 * The context is looked up by hash and must still be inside its claim window; an expired claim is
 * treated as no claim at all, which is the same rule {@link claimInvitation} uses when deciding a
 * stale claim may be taken over.
 */
export async function resolveRegistrationContext(
  db: Database,
  registrationContext: string,
  now: Date = new Date(),
): Promise<ResolvedContext> {
  const contextHash = await hashToken(registrationContext)
  const [invitation] = await db
    .select()
    .from(registrationInvites)
    .where(eq(registrationInvites.claimContextHash, contextHash))
    .limit(1)

  if (!invitation || invitation.revokedAt !== null || invitation.status !== 'claimed') {
    throw new ApiError('INVITE_INVALID')
  }
  if (invitation.usedAt !== null) {
    throw new ApiError('INVITE_USED')
  }
  if (!invitation.claimExpiresAt || invitation.claimExpiresAt.getTime() <= now.getTime()) {
    throw new ApiError('INVITE_EXPIRED')
  }

  const role = ROLES.includes(invitation.role as Role) ? (invitation.role as Role) : 'Viewer'
  return {
    invitationId: invitation.id,
    kind: invitation.kind === 'recovery' ? 'recovery' : 'registration',
    role,
    displayName: invitation.displayName,
    targetUserId: invitation.targetUserId,
  }
}

/**
 * Spend the invitation, permanently.
 *
 * Conditional on the claim still being the one this context owns, so a context that was superseded
 * by a later claim cannot complete. Returns false if the transition did not happen; the caller
 * must treat that as a failed registration and not create a user.
 */
export async function consumeInvitation(
  db: Database,
  invitationId: string,
  registrationContext: string,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const contextHash = await hashToken(registrationContext)
  const result = await db
    .update(registrationInvites)
    .set({ status: 'used', usedAt: now, usedByUserId: userId, claimContextHash: null })
    .where(
      and(
        eq(registrationInvites.id, invitationId),
        eq(registrationInvites.status, 'claimed'),
        eq(registrationInvites.claimContextHash, contextHash),
        isNull(registrationInvites.usedAt),
        isNull(registrationInvites.revokedAt),
      ),
    )
  return rowsAffected(result) === 1
}

/** Revoke an unspent invitation. Returns false if it was already used or already revoked. */
export async function revokeInvitation(
  db: Database,
  invitationId: string,
  revokedByUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await db
    .update(registrationInvites)
    .set({ status: 'revoked', revokedAt: now, revokedByUserId, claimContextHash: null })
    .where(
      and(
        eq(registrationInvites.id, invitationId),
        isNull(registrationInvites.usedAt),
        isNull(registrationInvites.revokedAt),
      ),
    )
  return rowsAffected(result) === 1
}
