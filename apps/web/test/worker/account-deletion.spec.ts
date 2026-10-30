/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import {
  accountDeletions,
  cloudObjects,
  deletedAccountObjectKeys,
  quotaReservations,
  user as users,
} from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import { newId } from '../../worker/lib/ids.ts'
import {
  beginAccountDeletion,
  sweepDeletedAccountObjectKeys,
} from '../../worker/services/account-deletion.ts'
import {
  commitUploadedObject,
  finaliseReservation,
  getQuotaState,
  releaseReservation,
  reserveQuota,
  sweepStaleReservations,
  unwindUploadedObject,
} from '../../worker/services/quota.ts'
import { sourceKey } from '../../worker/services/storage.ts'
import { apiFetch, createRun, createUser, db, ORIGIN, type TestUser } from './helpers/client.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Real D1/R2 with a controlled transport boundary; no timers decide the interleaving. */
function bucketWith(overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(env.AAT_OBJECTS, {
    get(target, key) {
      const replacement = Reflect.get(overrides, key)
      if (replacement !== undefined) return replacement
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function request(bucket: R2Bucket, path: string, owner: TestUser, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('cookie', owner.cookie)
  headers.set('origin', ORIGIN)
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers }),
    { ...env, AAT_OBJECTS: bucket },
    createExecutionContext(),
  )
}

async function sourceUpload(bucket: R2Bucket, owner: TestUser, runId: string): Promise<Response> {
  const bytes = new TextEncoder().encode('time,force\n0,1\n')
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const query = new URLSearchParams({ declaredBytes: String(bytes.length), sha256, filename: 'source.csv' })
  return request(bucket, `/api/v1/runs/${runId}/source?${query}`, owner, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv', 'x-aat-source-backup': 'requested-by-user' },
    body: bytes,
  })
}

const deleteUser = (bucket: R2Bucket, admin: TestUser, userId: string) =>
  request(bucket, `/api/v1/admin/users/${userId}`, admin, { method: 'DELETE' })

describe('account deletion and uploads', () => {
  it('closes admission and waits for an active PUT, then completes on retry', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const runId = await createRun(owner)
    const entered = deferred<string>()
    const resume = deferred<void>()
    const bucket = bucketWith({
      put: async (...args: Parameters<R2Bucket['put']>) => {
        entered.resolve(args[0])
        await resume.promise
        return env.AAT_OBJECTS.put(...args)
      },
    })
    const uploading = sourceUpload(bucket, owner, runId)
    const key = await entered.promise
    let deleted: Response
    try {
      deleted = await deleteUser(bucket, admin, owner.userId)
    } finally {
      resume.resolve()
    }
    const uploaded = await uploading
    expect(deleted.status).toBe(409)
    expect(await deleted.json()).toMatchObject({
      error: { details: { reason: 'account_deletion_in_progress' } },
    })
    expect(uploaded.status).toBe(404)
    expect((await deleteUser(bucket, admin, owner.userId)).status).toBe(200)
    expect(await env.AAT_OBJECTS.head(key)).toBeNull()
    expect(await db().select().from(users).where(eq(users.id, owner.userId))).toHaveLength(0)
  })

  it('retains an expired reservation key after cascade and recovers a late PUT whose handler fails', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const runId = await createRun(owner)
    const entered = deferred<string>()
    const resume = deferred<void>()
    const bucket = bucketWith({
      put: async (...args: Parameters<R2Bucket['put']>) => {
        entered.resolve(args[0])
        await resume.promise
        await env.AAT_OBJECTS.put(...args)
        throw new Error('injected loss after the PUT reached R2')
      },
    })
    const uploading = sourceUpload(bucket, owner, runId)
    const key = await entered.promise
    await db()
      .update(quotaReservations)
      .set({ expiresAt: new Date(0) })
      .where(eq(quotaReservations.userId, owner.userId))
    let deleted: Response
    try {
      deleted = await deleteUser(bucket, admin, owner.userId)
    } finally {
      resume.resolve()
    }
    expect(deleted.status).toBe(200)
    expect((await uploading).status).toBe(500)
    expect(
      await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, owner.userId)),
    ).toHaveLength(0)
    expect(
      await db().select().from(quotaReservations).where(eq(quotaReservations.userId, owner.userId)),
    ).toHaveLength(0)
    expect(await env.AAT_OBJECTS.head(key)).not.toBeNull()
    await sweepStaleReservations(db(), env.AAT_OBJECTS)
    expect(await env.AAT_OBJECTS.head(key)).toBeNull()
    // An administrator can repeat cleanup even though the user and its cascades are gone.
    expect((await deleteUser(bucket, admin, owner.userId)).status).toBe(200)
  })

  it('keeps ordinary self-deletion forbidden', async () => {
    const admin = await createUser({ role: 'Admin' })
    expect(
      (
        await apiFetch(`/api/v1/admin/users/${admin.userId}`, {
          method: 'DELETE',
          cookie: admin.cookie,
        })
      ).status,
    ).toBe(403)
  })

  it('keeps the deletion barrier and keys after R2 failure, and retries without touching another owner', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)
    const otherRun = await createRun(colleague)
    expect((await sourceUpload(env.AAT_OBJECTS, owner, runId)).status).toBe(201)
    expect((await sourceUpload(env.AAT_OBJECTS, colleague, otherRun)).status).toBe(201)
    const [object] = await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, owner.userId))
    if (!object) throw new Error('source upload must have a row')
    let rejectDeletes = true
    const bucket = bucketWith({
      delete: async (keys) => {
        if (rejectDeletes && (Array.isArray(keys) ? keys : [keys]).includes(object.r2Key)) {
          throw new Error('injected R2 delete failure')
        }
        return env.AAT_OBJECTS.delete(keys)
      },
    })
    expect((await deleteUser(bucket, admin, owner.userId)).status).toBe(500)
    expect(await db().select().from(users).where(eq(users.id, owner.userId))).toHaveLength(1)
    expect(
      await db().select().from(accountDeletions).where(eq(accountDeletions.userId, owner.userId)),
    ).toHaveLength(1)
    expect(
      await db()
        .select()
        .from(deletedAccountObjectKeys)
        .where(eq(deletedAccountObjectKeys.r2Key, object.r2Key)),
    ).toHaveLength(1)
    await expect(
      reserveQuota(db(), owner.userId, 1, 'source', sourceKey(owner.userId, runId, newId()), 900),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' })
    rejectDeletes = false
    expect((await deleteUser(bucket, admin, owner.userId)).status).toBe(200)
    expect(await env.AAT_OBJECTS.head(object.r2Key)).toBeNull()
    expect((await apiFetch(`/api/v1/runs/${otherRun}/source`, { cookie: colleague.cookie })).status).toBe(200)
    const otherQuota = await getQuotaState(db(), colleague.userId)
    expect(otherQuota).toMatchObject({ bytesUsed: 15, bytesReserved: 0, objectCount: 1 })
  })

  it('captures an admitted key before its object row exists and refuses later admissions atomically', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)
    const key = sourceKey(owner.userId, runId, newId())
    const reservation = await reserveQuota(db(), owner.userId, 15, 'source', key, 900)
    expect(
      await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, owner.userId)),
    ).toHaveLength(0)
    await beginAccountDeletion(db(), owner.userId)
    expect(
      await db().select().from(deletedAccountObjectKeys).where(eq(deletedAccountObjectKeys.r2Key, key)),
    ).toHaveLength(1)
    await expect(reserveQuota(db(), owner.userId, 15, 'source', `${key}-retry`, 900)).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
    })
    expect(await finaliseReservation(db(), reservation, 15, owner.userId)).toBe(false)
    expect(await getQuotaState(db(), owner.userId)).toMatchObject({ bytesUsed: 0, bytesReserved: 15 })
    await expect(
      reserveQuota(db(), colleague.userId, 15, 'source', `sources/${colleague.userId}/unrelated.csv`, 900),
    ).resolves.toMatchObject({ bytes: 15 })
  })

  it('does not leave quota held if recording the admitted key fails', async () => {
    const owner = await createUser()
    // Failure at the old UPDATE→INSERT gap: before the fix this leaves bytes_reserved charged
    // with no key for deletion to capture. Both effects now roll back in one real D1 batch.
    await env.DB.prepare(`CREATE TRIGGER reject_test_reservation BEFORE INSERT ON quota_reservations
      WHEN NEW.user_id = '${owner.userId}' BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`).run()
    try {
      await expect(
        reserveQuota(db(), owner.userId, 15, 'source', `sources/${owner.userId}/never-admitted.csv`, 900),
      ).rejects.toThrow()
      expect(await getQuotaState(db(), owner.userId)).toMatchObject({ bytesReserved: 0 })
      expect(
        await db().select().from(quotaReservations).where(eq(quotaReservations.userId, owner.userId)),
      ).toHaveLength(0)
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_test_reservation').run()
    }
  })

  it('records a racing admission completely before the barrier, or refuses it completely', async () => {
    const owner = await createUser()
    const key = `sources/${owner.userId}/racing-admission.csv`
    const [admission, deletion] = await Promise.allSettled([
      reserveQuota(db(), owner.userId, 15, 'source', key, 900),
      beginAccountDeletion(db(), owner.userId),
    ])
    expect(deletion.status).toBe('fulfilled')
    const reservations = await db()
      .select()
      .from(quotaReservations)
      .where(eq(quotaReservations.userId, owner.userId))
    const keys = await db()
      .select()
      .from(deletedAccountObjectKeys)
      .where(eq(deletedAccountObjectKeys.userId, owner.userId))
    if (admission.status === 'fulfilled') {
      expect(reservations).toHaveLength(1)
      expect(keys.map((row) => row.r2Key)).toContain(key)
      expect(await getQuotaState(db(), owner.userId)).toMatchObject({ bytesReserved: 15 })
    } else {
      expect(admission.reason).toMatchObject({ code: 'ACCOUNT_DELETION_PENDING' })
      expect(reservations).toHaveLength(0)
      expect(keys).toHaveLength(0)
      expect(await getQuotaState(db(), owner.userId)).toMatchObject({ bytesReserved: 0 })
    }
  })

  it('retains a released reservation without an object row, including repeated late PUTs after cascade', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const key = `sources/${owner.userId}/released.csv`
    const reservation = await reserveQuota(db(), owner.userId, 3, 'source', key, 900)
    await releaseReservation(db(), reservation, owner.userId)
    expect((await deleteUser(env.AAT_OBJECTS, admin, owner.userId)).status).toBe(200)
    expect(
      await db().select().from(deletedAccountObjectKeys).where(eq(deletedAccountObjectKeys.r2Key, key)),
    ).toHaveLength(1)
    for (let generation = 0; generation < 2; generation++) {
      await env.AAT_OBJECTS.put(key, new Uint8Array([1, 2, 3]))
      expect((await deleteUser(env.AAT_OBJECTS, admin, owner.userId)).status).toBe(200)
      expect(await env.AAT_OBJECTS.head(key)).toBeNull()
    }
  })

  it('retries safely when D1 fails after physical cleanup and before user cascade', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const runId = await createRun(owner)
    expect((await sourceUpload(env.AAT_OBJECTS, owner, runId)).status).toBe(201)
    const [object] = await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, owner.userId))
    if (!object) throw new Error('source upload must have a row')
    await env.DB.prepare(`CREATE TRIGGER reject_test_user_cascade BEFORE DELETE ON user
      WHEN OLD.id = '${owner.userId}' BEGIN SELECT RAISE(ABORT, 'injected cascade failure'); END`).run()
    try {
      expect((await deleteUser(env.AAT_OBJECTS, admin, owner.userId)).status).toBe(500)
      expect(await env.AAT_OBJECTS.head(object.r2Key)).toBeNull()
      expect(await db().select().from(users).where(eq(users.id, owner.userId))).toHaveLength(1)
      expect(
        await db()
          .select()
          .from(deletedAccountObjectKeys)
          .where(eq(deletedAccountObjectKeys.r2Key, object.r2Key)),
      ).toHaveLength(1)
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_test_user_cascade').run()
    }
    expect((await deleteUser(env.AAT_OBJECTS, admin, owner.userId)).status).toBe(200)
    expect(await db().select().from(users).where(eq(users.id, owner.userId))).toHaveLength(0)
    expect(await env.AAT_OBJECTS.head(object.r2Key)).toBeNull()
  })

  it('reclaims bytes when deletion lands after finalisation but before commit returns', async () => {
    const admin = await createUser({ role: 'Admin' })
    const owner = await createUser()
    const runId = await createRun(owner)
    const id = newId()
    const r2Key = sourceKey(owner.userId, runId, id)
    const bytes = new Uint8Array([1, 2, 3])
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    const reservation = await reserveQuota(db(), owner.userId, bytes.length, 'source', r2Key, 900)
    const object = {
      id,
      r2Key,
      sha256,
      ownerUserId: owner.userId,
      byteSize: bytes.length,
      reservationId: reservation.id,
    }
    await db()
      .insert(cloudObjects)
      .values({ ...object, kind: 'source', runId, contentType: 'text/csv', createdAt: new Date() })
    await env.AAT_OBJECTS.put(r2Key, bytes, { sha256 })
    const database = db()
    const finalised = deferred<void>()
    const resume = deferred<void>()
    const originalBatch = database.batch.bind(database)
    const spy = vi.spyOn(database, 'batch').mockImplementationOnce(async (queries) => {
      const result = await originalBatch(queries)
      finalised.resolve()
      await resume.promise
      return result
    })
    const committing = commitUploadedObject(database, env.AAT_OBJECTS, object, reservation, runId)
    await finalised.promise
    try {
      expect((await deleteUser(env.AAT_OBJECTS, admin, owner.userId)).status).toBe(200)
    } finally {
      resume.resolve()
      spy.mockRestore()
    }
    await committing
    // The route's later pointer/audit write could fail after cascade. Its unwind is safe even
    // after every user-owned row vanished; the independent ledger still owns physical cleanup.
    await unwindUploadedObject(database, env.AAT_OBJECTS, object)
    expect(await env.AAT_OBJECTS.head(r2Key)).toBeNull()
    expect(await getQuotaState(database, owner.userId)).toBeNull()
    expect(
      await database.select().from(deletedAccountObjectKeys).where(eq(deletedAccountObjectKeys.r2Key, r2Key)),
    ).toHaveLength(1)
  })

  it('rotates bounded recovery past failed and empty keys, including repeated passes at the same time', async () => {
    const ledgerOwner = newId()
    const keys = Array.from(
      { length: 25 },
      (_, index) => `sources/${ledgerOwner}/${String(index).padStart(2, '0')}.csv`,
    )
    const [emptyKey, failedKey] = keys
    const lastKey = keys.at(-1)
    if (!emptyKey || !failedKey || !lastKey) throw new Error('recovery fixture needs at least two keys')
    await db().insert(accountDeletions).values({ userId: ledgerOwner, startedAt: new Date() })
    await db()
      .insert(deletedAccountObjectKeys)
      .values(keys.map((r2Key) => ({ userId: ledgerOwner, r2Key })))
    for (const key of keys.slice(1)) await env.AAT_OBJECTS.put(key, new Uint8Array([1]))
    const checked: string[] = []
    const bucket = bucketWith({
      head: async (key) => {
        checked.push(key)
        if (key === failedKey) throw new Error('persistent failure must not starve later keys')
        return env.AAT_OBJECTS.head(key)
      },
    })
    try {
      // Older tests' records may also be in the global queue. This bound includes all of them.
      const records = await db().select().from(deletedAccountObjectKeys)
      for (let pass = 0; pass <= Math.ceil(records.length / 3); pass++) {
        await sweepDeletedAccountObjectKeys(db(), bucket, 3)
      }
      expect(keys.every((key) => checked.includes(key))).toBe(true)
      expect(await env.AAT_OBJECTS.head(failedKey)).not.toBeNull()
      expect(await env.AAT_OBJECTS.head(lastKey)).toBeNull()
      // A key found empty earlier can reappear much later; retention must cover it again.
      await env.AAT_OBJECTS.put(emptyKey, new Uint8Array([2]))
      for (let pass = 0; pass <= Math.ceil(records.length / 3); pass++) {
        await sweepDeletedAccountObjectKeys(db(), bucket, 3)
      }
      expect(await env.AAT_OBJECTS.head(emptyKey)).toBeNull()
    } finally {
      await db().delete(deletedAccountObjectKeys).where(eq(deletedAccountObjectKeys.userId, ledgerOwner))
      await db().delete(accountDeletions).where(eq(accountDeletions.userId, ledgerOwner))
      await env.AAT_OBJECTS.delete(keys)
    }
  })
})
