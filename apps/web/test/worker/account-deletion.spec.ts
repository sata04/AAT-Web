import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
  auditLogs,
  cloudObjects,
  quotaReservations,
  runs,
  user as userTable,
} from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import { reserveQuota, sweepStaleReservations } from '../../worker/services/quota.ts'
import { apiFetch, createRun, createUser, db, ORIGIN, type TestUser } from './helpers/client.ts'

async function uploadSource(user: TestUser, runId: string, bindings: Env = env) {
  const body = new TextEncoder().encode('time,value\n0,1\n')
  const hash = await crypto.subtle.digest('SHA-256', body)
  const sha256 = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return worker.fetch(
    new Request(
      `${ORIGIN}/api/v1/runs/${runId}/source?declaredBytes=${body.length}&sha256=${sha256}&filename=source.csv`,
      {
        method: 'PUT',
        headers: {
          origin: ORIGIN,
          cookie: user.cookie,
          'content-type': 'text/csv',
          'x-aat-source-backup': 'requested-by-user',
        },
        body,
      },
    ),
    bindings,
    createExecutionContext(),
  )
}

function withBucket(bucket: Pick<R2Bucket, 'put' | 'delete'>): Env {
  return {
    ...env,
    AAT_OBJECTS: new Proxy(env.AAT_OBJECTS, {
      get(target, property) {
        if (property === 'put' || property === 'delete') return bucket[property]
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
}

describe('account deletion barrier', () => {
  it('tombstones runs before cleanup and retains the account until a late PUT unwinds', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    await db()
      .update(userTable)
      .set({ banExpires: new Date(Date.now() - 1000) })
      .where(eq(userTable.id, user.userId))
    const runId = await createRun(user)
    let entered = () => {}
    let resume = () => {}
    const putting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const bindings = withBucket({
      put: async (...args: Parameters<R2Bucket['put']>) => {
        entered()
        await gate
        return env.AAT_OBJECTS.put(...args)
      },
      delete: env.AAT_OBJECTS.delete.bind(env.AAT_OBJECTS),
    })
    const upload = uploadSource(user, runId, bindings)
    await putting
    try {
      const deletion = await apiFetch(`/api/v1/admin/users/${user.userId}`, {
        method: 'DELETE',
        cookie: admin.cookie,
      })
      expect(deletion.status).toBe(403)
      const audit = await db().select().from(auditLogs).where(eq(auditLogs.targetId, user.userId))
      expect(audit).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: 'user.delete_pending',
            actorUserId: admin.userId,
            targetOwnerUserId: user.userId,
          }),
        ]),
      )
      // Expiry during the barrier must not erase the only evidence of this in-flight PUT.
      await db()
        .update(quotaReservations)
        .set({ expiresAt: new Date(0) })
        .where(eq(quotaReservations.userId, user.userId))
      await sweepStaleReservations(db(), env.AAT_OBJECTS, new Date(), 10000)
      const held = await db()
        .select()
        .from(quotaReservations)
        .where(eq(quotaReservations.userId, user.userId))
      expect(held[0]?.status).toBe('pending')
      expect(
        (
          await apiFetch(`/api/v1/admin/users/${user.userId}`, {
            method: 'DELETE',
            cookie: admin.cookie,
          })
        ).status,
      ).toBe(403)

      const [account] = await db().select().from(userTable).where(eq(userTable.id, user.userId))
      const [run] = await db().select().from(runs).where(eq(runs.id, runId))
      expect(account?.banned).toBe(true)
      expect(account?.banReason).toBe('account_deletion_in_progress')
      expect(account?.banExpires).toBeNull()
      expect(run?.deletedAt).not.toBeNull()
      expect(
        await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, user.userId)),
      ).toHaveLength(1)
      await expect(reserveQuota(db(), user.userId, 1, 'source', 'late-object', 900)).rejects.toMatchObject({
        code: 'QUOTA_EXCEEDED',
      })
      expect(
        (
          await apiFetch(`/api/v1/admin/users/${user.userId}`, {
            method: 'PATCH',
            cookie: admin.cookie,
            body: JSON.stringify({ banned: false }),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await apiFetch(`/api/v1/admin/quotas/${user.userId}`, {
            method: 'PUT',
            cookie: admin.cookie,
            body: JSON.stringify({ bytesLimit: 1048576 }),
          })
        ).status,
      ).toBe(403)
    } finally {
      resume()
    }
    expect((await upload).status).toBe(404)
    expect((await env.AAT_OBJECTS.list({ prefix: `sources/${user.userId}/` })).objects).toHaveLength(0)
    expect(
      (await apiFetch(`/api/v1/admin/users/${user.userId}`, { method: 'DELETE', cookie: admin.cookie }))
        .status,
    ).toBe(200)
    expect(await db().select().from(userTable).where(eq(userTable.id, user.userId))).toHaveLength(0)
  })

  it('rolls back barrier installation if its audit insert fails', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const runId = await createRun(user)
    await env.DB.prepare(`CREATE TRIGGER fail_barrier_audit BEFORE INSERT ON audit_logs
      WHEN NEW.target_id = '${user.userId}' AND NEW.action = 'user.delete_pending'
      BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`).run()
    try {
      expect(
        (
          await apiFetch(`/api/v1/admin/users/${user.userId}`, {
            method: 'DELETE',
            cookie: admin.cookie,
          })
        ).status,
      ).toBe(500)
    } finally {
      await env.DB.exec('DROP TRIGGER fail_barrier_audit')
    }
    const [account] = await db().select().from(userTable).where(eq(userTable.id, user.userId))
    const [run] = await db().select().from(runs).where(eq(runs.id, runId))
    expect(account?.banned).not.toBe(true)
    expect(run?.deletedAt).toBeNull()
    expect((await apiFetch(`/api/v1/runs/${runId}`, { cookie: user.cookie })).status).toBe(200)
  })

  it('keeps cleanup discoverable when R2 deletion fails and succeeds on a later DELETE', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const runId = await createRun(user)
    expect((await uploadSource(user, runId)).status).toBe(201)
    const [object] = await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, user.userId))
    if (!object) throw new Error('missing source')
    const bindings = withBucket({
      put: env.AAT_OBJECTS.put.bind(env.AAT_OBJECTS),
      delete: async () => {
        throw new Error('temporary storage failure')
      },
    })
    const failed = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/admin/users/${user.userId}`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie: admin.cookie },
      }),
      bindings,
      createExecutionContext(),
    )
    expect(failed.status).toBe(500)
    expect(await db().select().from(cloudObjects).where(eq(cloudObjects.id, object.id))).toHaveLength(1)
    expect(await env.AAT_OBJECTS.head(object.r2Key)).not.toBeNull()
    expect(
      (await apiFetch(`/api/v1/admin/users/${user.userId}`, { method: 'DELETE', cookie: admin.cookie }))
        .status,
    ).toBe(200)
    expect(await env.AAT_OBJECTS.head(object.r2Key)).toBeNull()
  })

  it('cleans reservation-only orphan keys before the account cascade', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const key = `sources/${user.userId}/abandoned`
    await db()
      .insert(quotaReservations)
      .values({
        id: `orphan-${user.userId}`,
        userId: user.userId,
        bytes: 4,
        purpose: 'source',
        r2Key: key,
        status: 'released',
        createdAt: new Date(),
        expiresAt: new Date(),
      })
    await env.AAT_OBJECTS.put(key, 'data')
    expect(
      (await apiFetch(`/api/v1/admin/users/${user.userId}`, { method: 'DELETE', cookie: admin.cookie }))
        .status,
    ).toBe(200)
    expect(await env.AAT_OBJECTS.head(key)).toBeNull()
  })
})
