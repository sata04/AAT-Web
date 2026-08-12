/**
 * The signed-in user's own view of themselves: identity, capabilities, storage.
 *
 * `email` is absent, deliberately — see auth/identity.ts. The client renders `displayName`.
 */

import { Hono } from 'hono'
import { capabilitiesForRole } from '@aat/shared'
import { resolveConfig } from '../config.ts'
import type { AppEnv } from '../middleware/authorize.ts'
import { requireSession, withDatabase } from '../middleware/authorize.ts'
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
