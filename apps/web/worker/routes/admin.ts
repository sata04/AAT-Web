/**
 * Administration.
 *
 * Every route here is gated by a capability — `user:manage`, `invitation:manage`, `audit:read`,
 * `quota:manage` — and never by a role comparison. What an administrator can do is therefore
 * visible in one table (@aat/shared's `ROLE_CAPABILITIES`) rather than distributed across
 * handlers.
 *
 * What administration deliberately does NOT include: reading another researcher's measurements.
 * These endpoints expose *metadata* — who exists, how much they store, what they did — and never
 * snapshot or poster bytes. Running the deployment and reading the data in it are different
 * powers, and only the first has been granted.
 */

import { ApiError, ROLES } from '@aat/shared'
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { toPublicUser } from '../auth/identity.ts'
import { createInvitation, revokeInvitation } from '../auth/invitations.ts'
import { resolveConfig } from '../config.ts'
import {
  analysisRevisions,
  auditLogs,
  cloudObjects,
  passkey,
  quotaUsage,
  registrationInvites,
  runs,
  user as userTable,
} from '../db/schema.ts'
import type { AppEnv } from '../middleware/authorize.ts'
import { requireCapability, requireSession, withDatabase } from '../middleware/authorize.ts'
import { validate } from '../middleware/validate.ts'
import { writeAuditLog } from '../services/audit.ts'
import { getCircuitBreaker, setCircuitBreaker } from '../services/flags.ts'
import { ensureQuotaRow, setQuotaLimit } from '../services/quota.ts'
import { consumeRateLimit, RATE_LIMITS, rateLimitKey } from '../services/rate-limit.ts'

export const adminRoutes = new Hono<AppEnv>()

adminRoutes.use('*', withDatabase, requireSession)

const PAGE_SIZE = 50

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(64).optional(),
})

/* ------------------------------------------------------------------------------------------- */
/* Users                                                                                        */
/* ------------------------------------------------------------------------------------------- */

adminRoutes.get(
  '/users',
  requireCapability('user:manage'),
  validate('query', paginationSchema),
  async (context) => {
    const db = context.get('db')
    const query = context.req.valid('query')
    const limit = query.limit ?? PAGE_SIZE

    const conditions = query.cursor ? [lt(userTable.id, query.cursor)] : []
    const rows = await db
      .select()
      .from(userTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(userTable.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    return context.json({
      // toPublicUser drops the synthetic address: it is a data-model artefact, not an identity,
      // and an admin console is exactly where it would start being treated as one.
      users: page.map(toPublicUser),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    })
  },
)

const updateUserSchema = z.object({
  role: z.enum(ROLES).optional(),
  banned: z.boolean().optional(),
  banReason: z.string().max(500).nullable().optional(),
})

adminRoutes.patch(
  '/users/:userId',
  requireCapability('user:manage'),
  validate('json', updateUserSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const targetId = context.req.param('userId')
    const body = context.req.valid('json')
    const now = new Date()

    const [target] = await db.select().from(userTable).where(eq(userTable.id, targetId)).limit(1)
    if (!target) throw new ApiError('RESOURCE_NOT_FOUND')

    if (targetId === actor.userId && (body.role !== undefined || body.banned === true)) {
      // An administrator who demotes or bans themselves can leave a deployment with no
      // administrator at all, and there is no email-based recovery path to get one back.
      throw new ApiError('FORBIDDEN', { details: { reason: 'cannot_modify_own_privileges' } })
    }

    const patch: Record<string, unknown> = { updatedAt: now }
    if (body.role !== undefined) patch.role = body.role
    if (body.banned !== undefined) {
      patch.banned = body.banned
      patch.banReason = body.banned ? (body.banReason ?? null) : null
    }
    await db.update(userTable).set(patch).where(eq(userTable.id, targetId))

    if (body.role !== undefined) {
      await writeAuditLog(db, {
        actorUserId: actor.userId,
        action: 'user.role_change',
        targetType: 'user',
        targetId,
        details: { from: target.role, to: body.role },
        headers: context.req.raw.headers,
      })
    }
    if (body.banned !== undefined) {
      await writeAuditLog(db, {
        actorUserId: actor.userId,
        action: body.banned ? 'user.ban' : 'user.unban',
        targetType: 'user',
        targetId,
        headers: context.req.raw.headers,
      })
    }

    return context.json({ ok: true })
  },
)

adminRoutes.delete('/users/:userId', requireCapability('user:manage'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const targetId = context.req.param('userId')
  if (targetId === actor.userId) {
    throw new ApiError('FORBIDDEN', { details: { reason: 'cannot_delete_self' } })
  }

  const [target] = await db.select().from(userTable).where(eq(userTable.id, targetId)).limit(1)
  if (!target) throw new ApiError('RESOURCE_NOT_FOUND')

  // Delete the bytes before the row: the cascade would otherwise remove every record of which
  // objects existed, leaving them in R2 with nothing pointing at them and no way to find them.
  const objects = await db.select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, targetId))
  for (const object of objects) {
    await context.env.AAT_OBJECTS.delete(object.r2Key)
  }
  await db.delete(userTable).where(eq(userTable.id, targetId))

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'user.delete',
    targetType: 'user',
    targetId,
    details: { objectsDeleted: objects.length },
    headers: context.req.raw.headers,
  })

  return context.json({ ok: true, objectsDeleted: objects.length })
})

adminRoutes.get('/users/:userId/passkeys', requireCapability('user:manage'), async (context) => {
  const db = context.get('db')
  const rows = await db
    .select({
      id: passkey.id,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, context.req.param('userId')))

  return context.json({
    passkeys: rows.map((row) => ({
      id: row.id,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
  })
})

/**
 * Delete a passkey — but never a user's last one.
 *
 * With no password, no email and no social login, the passkey *is* the account. Removing the last
 * one does not lock a user out temporarily; it destroys their access with no self-service way
 * back, and the only remedy would be an administrator issuing a recovery invitation to an account
 * that can no longer prove it is theirs. So the deletion is refused, and the correct action —
 * issuing a recovery invitation first, then removing the old credential — is left to be done in
 * that order.
 */
adminRoutes.delete('/passkeys/:passkeyId', requireCapability('user:manage'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const passkeyId = context.req.param('passkeyId')

  const [target] = await db.select().from(passkey).where(eq(passkey.id, passkeyId)).limit(1)
  if (!target) throw new ApiError('RESOURCE_NOT_FOUND')

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(passkey)
    .where(eq(passkey.userId, target.userId))
  if ((counted?.count ?? 0) <= 1) {
    throw new ApiError('FORBIDDEN', { details: { reason: 'cannot_delete_last_passkey' } })
  }

  await db.delete(passkey).where(eq(passkey.id, passkeyId))
  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'passkey.delete',
    targetType: 'passkey',
    targetId: passkeyId,
    details: { userId: target.userId },
    headers: context.req.raw.headers,
  })

  return context.json({ ok: true })
})

/* ------------------------------------------------------------------------------------------- */
/* Invitations                                                                                  */
/* ------------------------------------------------------------------------------------------- */

const createInvitationSchema = z.object({
  kind: z.enum(['registration', 'recovery']),
  role: z.enum(ROLES),
  displayName: z.string().min(1).max(120),
  note: z.string().max(500).optional(),
  /** Required for a recovery invitation: the existing user regaining access. */
  targetUserId: z.string().min(1).max(64).optional(),
  ttlHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14),
})

adminRoutes.post(
  '/invitations',
  requireCapability('invitation:manage'),
  validate('json', createInvitationSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const body = context.req.valid('json')
    const now = new Date()

    await consumeRateLimit(db, rateLimitKey('inviteCreate', actor.userId), RATE_LIMITS.inviteCreate, now)

    if (body.kind === 'recovery') {
      if (!body.targetUserId) {
        throw new ApiError('RECOVERY_INVALID', { details: { reason: 'target_user_required' } })
      }
      const [target] = await db
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.id, body.targetUserId))
        .limit(1)
      if (!target) throw new ApiError('RECOVERY_INVALID', { details: { reason: 'unknown_user' } })
    }

    const invitation = await createInvitation(
      db,
      {
        kind: body.kind,
        role: body.role,
        displayName: body.displayName,
        note: body.note,
        targetUserId: body.targetUserId,
        ttlSeconds: body.ttlHours * 3600,
        createdByUserId: actor.userId,
      },
      now,
    )

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'invitation.create',
      targetType: 'invitation',
      targetId: invitation.id,
      // The id, the kind and the role. Never the token, and never its hash.
      details: { kind: body.kind, role: body.role, expiresAt: invitation.expiresAt.toISOString() },
      headers: context.req.raw.headers,
    })

    return context.json(
      {
        invitation: {
          id: invitation.id,
          expiresAt: invitation.expiresAt.toISOString(),
          /**
           * Shown exactly once. It is not stored anywhere in plaintext and cannot be retrieved
           * again; a lost token means issuing a new invitation.
           */
          token: invitation.token,
        },
      },
      201,
    )
  },
)

adminRoutes.get(
  '/invitations',
  requireCapability('invitation:manage'),
  validate('query', paginationSchema),
  async (context) => {
    const db = context.get('db')
    const query = context.req.valid('query')
    const limit = query.limit ?? PAGE_SIZE

    const rows = await db
      .select()
      .from(registrationInvites)
      .where(query.cursor ? lt(registrationInvites.id, query.cursor) : undefined)
      .orderBy(desc(registrationInvites.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    return context.json({
      invitations: page.map((row) => ({
        id: row.id,
        kind: row.kind,
        role: row.role,
        displayName: row.displayName,
        note: row.note,
        status: row.status,
        targetUserId: row.targetUserId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        usedAt: row.usedAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        // No token, no token hash. The listing must be safe to put on a screen.
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    })
  },
)

adminRoutes.post(
  '/invitations/:invitationId/revoke',
  requireCapability('invitation:manage'),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const invitationId = context.req.param('invitationId')

    const revoked = await revokeInvitation(db, invitationId, actor.userId)
    if (!revoked) {
      // Already used, already revoked, or never existed — all answered the same way, because the
      // difference is only interesting to someone probing invitation ids.
      throw new ApiError('INVITE_INVALID', { details: { reason: 'not_revocable' } })
    }

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'invitation.revoke',
      targetType: 'invitation',
      targetId: invitationId,
      headers: context.req.raw.headers,
    })

    return context.json({ ok: true })
  },
)

/* ------------------------------------------------------------------------------------------- */
/* Runs and storage                                                                             */
/* ------------------------------------------------------------------------------------------- */

adminRoutes.get('/storage', requireCapability('quota:manage'), async (context) => {
  const db = context.get('db')

  const perUser = await db
    .select({
      userId: quotaUsage.userId,
      displayName: userTable.name,
      role: userTable.role,
      bytesUsed: quotaUsage.bytesUsed,
      bytesReserved: quotaUsage.bytesReserved,
      bytesLimit: quotaUsage.bytesLimit,
      objectCount: quotaUsage.objectCount,
    })
    .from(quotaUsage)
    .innerJoin(userTable, eq(userTable.id, quotaUsage.userId))
    .orderBy(desc(quotaUsage.bytesUsed))
    .limit(200)

  const [totals] = await db
    .select({
      objects: sql<number>`count(*)`,
      bytes: sql<number>`COALESCE(SUM(${cloudObjects.byteSize}), 0)`,
    })
    .from(cloudObjects)
    .where(isNull(cloudObjects.deletedAt))

  const [runCounts] = await db
    .select({ runs: sql<number>`count(*)` })
    .from(runs)
    .where(isNull(runs.deletedAt))

  const [revisionCounts] = await db.select({ revisions: sql<number>`count(*)` }).from(analysisRevisions)

  return context.json({
    perUser,
    totals: {
      objects: totals?.objects ?? 0,
      bytes: totals?.bytes ?? 0,
      runs: runCounts?.runs ?? 0,
      revisions: revisionCounts?.revisions ?? 0,
    },
  })
})

/* ------------------------------------------------------------------------------------------- */
/* Quotas                                                                                       */
/* ------------------------------------------------------------------------------------------- */

const quotaSchema = z.object({ bytesLimit: z.number().int().min(0) })

adminRoutes.put(
  '/quotas/:userId',
  requireCapability('quota:manage'),
  validate('json', quotaSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const config = resolveConfig(context.env)
    const targetId = context.req.param('userId')
    const body = context.req.valid('json')

    const [target] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.id, targetId))
      .limit(1)
    if (!target) throw new ApiError('RESOURCE_NOT_FOUND')

    await ensureQuotaRow(db, targetId, config.defaultQuotaBytes)
    const state = await setQuotaLimit(db, targetId, body.bytesLimit)

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'quota.update',
      targetType: 'user',
      targetId,
      details: { bytesLimit: body.bytesLimit },
      headers: context.req.raw.headers,
    })

    return context.json({ quota: state })
  },
)

/* ------------------------------------------------------------------------------------------- */
/* Renderer circuit breaker                                                                     */
/* ------------------------------------------------------------------------------------------- */

adminRoutes.get('/renderer', requireCapability('quota:manage'), async (context) => {
  return context.json({ circuitBreaker: await getCircuitBreaker(context.get('db')) })
})

const breakerSchema = z.object({
  open: z.boolean(),
  reason: z.string().max(200).nullable().optional(),
})

adminRoutes.put(
  '/renderer',
  requireCapability('quota:manage'),
  validate('json', breakerSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const body = context.req.valid('json')

    const state = await setCircuitBreaker(db, body.open, body.reason ?? null, actor.userId)
    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'renderer.circuit_breaker',
      targetType: 'system_flag',
      targetId: 'poster.renderer.circuit_breaker',
      details: { open: body.open, reason: body.reason ?? null },
      headers: context.req.raw.headers,
    })

    return context.json({ circuitBreaker: state })
  },
)

/* ------------------------------------------------------------------------------------------- */
/* Audit log                                                                                    */
/* ------------------------------------------------------------------------------------------- */

const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(64).optional(),
  actorUserId: z.string().max(64).optional(),
})

adminRoutes.get(
  '/audit',
  requireCapability('audit:read'),
  validate('query', auditQuerySchema),
  async (context) => {
    const db = context.get('db')
    const query = context.req.valid('query')
    const limit = query.limit ?? PAGE_SIZE

    const conditions = []
    if (query.cursor) conditions.push(lt(auditLogs.id, query.cursor))
    if (query.action) conditions.push(eq(auditLogs.action, query.action))
    if (query.actorUserId) conditions.push(eq(auditLogs.actorUserId, query.actorUserId))

    const rows = await db
      .select()
      .from(auditLogs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLogs.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    return context.json({
      entries: page.map((row) => ({
        id: row.id,
        actorUserId: row.actorUserId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        ipAddress: row.ipAddress,
        details: row.details ? (JSON.parse(row.details) as unknown) : null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    })
  },
)
