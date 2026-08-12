/**
 * The signed-in user's own view of themselves: identity, capabilities, storage.
 *
 * `email` is absent, deliberately — see auth/identity.ts. The client renders `displayName`.
 */

import { ApiError, capabilitiesForRole } from '@aat/shared'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { resolveConfig } from '../config.ts'
import { passkey } from '../db/schema.ts'
import type { AppEnv } from '../middleware/authorize.ts'
import { requireSession, withDatabase } from '../middleware/authorize.ts'
import { writeAuditLog } from '../services/audit.ts'
import { ensureQuotaRow, getQuotaState } from '../services/quota.ts'

export const meRoutes = new Hono<AppEnv>()

meRoutes.use('*', withDatabase, requireSession)

meRoutes.get('/', async (context) => {
  const actor = context.get('actor')
  const db = context.get('db')
  const config = resolveConfig(context.env)

  await ensureQuotaRow(db, actor.userId, config.defaultQuotaBytes)
  const quota = await getQuotaState(db, actor.userId)

  return context.json({
    user: { id: actor.userId, displayName: actor.displayName, role: actor.role },
    capabilities: capabilitiesForRole(actor.role),
    quota,
  })
})

/** The caller's own credentials. Public keys and counters are not returned; they are not useful to a UI. */
meRoutes.get('/passkeys', async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const rows = await db
    .select({
      id: passkey.id,
      name: passkey.name,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt,
      lastUsedAt: passkey.lastUsedAt,
    })
    .from(passkey)
    .where(eq(passkey.userId, actor.userId))

  return context.json({
    passkeys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    })),
  })
})

/**
 * Remove one of the caller's own passkeys — never the last one.
 *
 * Same rule as the administrative path, for the same reason: with no password and no email, the
 * last passkey is the only way back in. Deleting it is not a reversible mistake.
 */
meRoutes.delete('/passkeys/:passkeyId', async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  const passkeyId = context.req.param('passkeyId')

  const [target] = await db
    .select()
    .from(passkey)
    .where(and(eq(passkey.id, passkeyId), eq(passkey.userId, actor.userId)))
    .limit(1)
  if (!target) throw new ApiError('RESOURCE_NOT_FOUND')

  const [counted] = await db
    .select({ count: sql<number>`count(*)` })
    .from(passkey)
    .where(eq(passkey.userId, actor.userId))
  if ((counted?.count ?? 0) <= 1) {
    throw new ApiError('FORBIDDEN', { details: { reason: 'cannot_delete_last_passkey' } })
  }

  await db.delete(passkey).where(eq(passkey.id, passkeyId))
  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'passkey.delete',
    targetType: 'passkey',
    targetId: passkeyId,
    headers: context.req.raw.headers,
  })

  return context.json({ ok: true })
})
