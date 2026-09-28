import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { auditLogs, quotaUsage, user as userTable } from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import {
  ACCOUNT_DELETION_REASON,
  ensureQuotaRow,
  finaliseReservation,
  reserveQuota,
  setQuotaLimit,
} from '../../worker/services/quota.ts'
import { apiFetch, createUser, db, ORIGIN } from './helpers/client.ts'
import { interceptD1 } from './helpers/intercept-d1.ts'

describe('admin writes racing the account deletion barrier', () => {
  it.each([
    ['unban', 'before'],
    ['unban', 'after'],
    ['quota', 'before'],
    ['quota', 'after'],
  ] as const)('rejects %s when DELETE installs the barrier %s its UPDATE returns', async (kind, phase) => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    await ensureQuotaRow(db(), user.userId, 1048576)
    // Keep DELETE at the durable barrier, so the paused update races a live account row.
    await reserveQuota(db(), user.userId, 4, 'source', `sources/${user.userId}/pending`, 900)
    if (kind === 'unban') {
      await db()
        .update(userTable)
        .set({ banned: true, banReason: 'ordinary ban' })
        .where(eq(userTable.id, user.userId))
    }
    let entered = () => {}
    let resume = () => {}
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const statement = kind === 'unban' ? /^update "user" set/i : /^update "quota_usage" set/i
    const bindings = {
      ...env,
      DB: interceptD1(env.DB, async (sql, currentPhase) => {
        if (currentPhase !== phase || !statement.test(sql)) return
        entered()
        await gate
      }),
    }
    const update = worker.fetch(
      new Request(`${ORIGIN}/api/v1/admin/${kind === 'unban' ? 'users' : 'quotas'}/${user.userId}`, {
        method: kind === 'unban' ? 'PATCH' : 'PUT',
        headers: { origin: ORIGIN, cookie: admin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'unban' ? { banned: false } : { bytesLimit: 2097152 }),
      }),
      bindings,
      createExecutionContext(),
    )
    await paused
    try {
      expect(
        (await apiFetch(`/api/v1/admin/users/${user.userId}`, { method: 'DELETE', cookie: admin.cookie }))
          .status,
      ).toBe(403)
    } finally {
      resume()
    }
    const response = await update
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { details: { reason: ACCOUNT_DELETION_REASON } } })
    const [account] = await db().select().from(userTable).where(eq(userTable.id, user.userId))
    expect(account).toMatchObject({ banned: true, banReason: ACCOUNT_DELETION_REASON, banExpires: null })
    const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
    expect(quota).toMatchObject({ bytesLimit: 0, bytesReserved: 4 })
    const audit = await db().select().from(auditLogs).where(eq(auditLogs.targetId, user.userId))
    expect(audit.some((row) => row.action === (kind === 'unban' ? 'user.unban' : 'quota.update'))).toBe(false)
  })

  it('enforces the barrier in quota services even with a nonzero ceiling', async () => {
    const user = await createUser()
    await ensureQuotaRow(db(), user.userId, 1048576)
    const reservation = await reserveQuota(db(), user.userId, 4, 'source', `sources/${user.userId}/held`, 900)
    // Deliberately leave headroom: the admission decision must check the barrier itself.
    await db()
      .update(userTable)
      .set({ banned: true, banReason: ACCOUNT_DELETION_REASON })
      .where(eq(userTable.id, user.userId))
    await expect(
      reserveQuota(db(), user.userId, 4, 'source', `sources/${user.userId}/new`, 900),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
    await expect(setQuotaLimit(db(), user.userId, 2097152)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: ACCOUNT_DELETION_REASON },
    })
    expect(await finaliseReservation(db(), reservation, 4, user.userId)).toBe(false)
    const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
    expect(quota).toMatchObject({ bytesLimit: 1048576, bytesReserved: 4, bytesUsed: 0, objectCount: 0 })
  })
})
