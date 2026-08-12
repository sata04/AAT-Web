/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Storage quotas, and the accounting that has to survive concurrency and lying clients.
 *
 * The four cases here are the ones a naive "check, write, add" implementation gets wrong:
 * two uploads racing for the last byte, a falsified size, an upload that never finishes, and a
 * deletion that has to give the space back.
 */

import { env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { cloudObjects, quotaReservations, quotaUsage } from '../../worker/db/schema.ts'
import { newId } from '../../worker/lib/ids.ts'
import { apiFetch, createRevision, createRun, createUser, db, type TestUser } from './helpers/client.ts'
import { buildSnapshot, encodeForUpload } from './helpers/snapshot.ts'

const SOURCE_SHA = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)

interface QuotaSnapshot {
  bytesUsed: number
  bytesReserved: number
  bytesLimit: number
  objectCount: number
}

async function quotaOf(user: TestUser): Promise<QuotaSnapshot> {
  const response = await apiFetch('/api/v1/me', { cookie: user.cookie })
  const body = (await response.json()) as { quota: QuotaSnapshot }
  return body.quota
}

/** Set a user's ceiling through the administrative endpoint, the way an operator would. */
async function setLimit(admin: TestUser, userId: string, bytesLimit: number): Promise<void> {
  const response = await apiFetch(`/api/v1/admin/quotas/${userId}`, {
    method: 'PUT',
    cookie: admin.cookie,
    body: JSON.stringify({ bytesLimit }),
  })
  expect(response.status).toBe(200)
}

interface UploadOptions {
  declaredBytes?: number
  sha256?: string
  configHash?: string
  paddingBytes?: number
}

async function uploadSnapshot(
  user: TestUser,
  revisionId: string,
  options: UploadOptions = {},
): Promise<{ response: Response; size: number }> {
  const snapshot = buildSnapshot({
    sourceSha256: SOURCE_SHA,
    configHash: options.configHash ?? CONFIG_HASH,
    ...(options.paddingBytes === undefined ? {} : { paddingBytes: options.paddingBytes }),
  })
  const encoded = await encodeForUpload(snapshot)
  const query = new URLSearchParams({
    declaredBytes: String(options.declaredBytes ?? encoded.bytes.length),
    sha256: options.sha256 ?? encoded.sha256,
    format: 'json',
  })
  const response = await apiFetch(`/api/v1/revisions/${revisionId}/snapshot?${query}`, {
    method: 'PUT',
    cookie: user.cookie,
    headers: { 'content-type': 'application/json' },
    // Cast: a Uint8Array is a valid body, but lib.dom's BodyInit only admits ArrayBuffer-backed views.
    body: encoded.bytes as BodyInit,
  })
  return { response, size: encoded.bytes.length }
}

/** The encoded size of the standard test snapshot, for sizing quota limits against. */
async function snapshotSize(): Promise<number> {
  const encoded = await encodeForUpload(buildSnapshot({ sourceSha256: SOURCE_SHA, configHash: CONFIG_HASH }))
  return encoded.bytes.length
}

describe('snapshot upload', () => {
  it('stores a snapshot and charges its actual size', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const { response, size } = await uploadSnapshot(user, revisionId)
    expect(response.status).toBe(201)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.objectCount).toBe(1)

    const download = await apiFetch(`/api/v1/revisions/${revisionId}/snapshot`, { cookie: user.cookie })
    expect(download.status).toBe(200)
    expect((await download.arrayBuffer()).byteLength).toBe(size)
  })

  it('rejects a snapshot whose hash does not match its bytes', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const { response } = await uploadSnapshot(user, revisionId, { sha256: 'f'.repeat(64) })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SNAPSHOT_INVALID')

    // The reservation was given back, so a failed upload does not eat quota.
    const quota = await quotaOf(user)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.bytesUsed).toBe(0)
  })

  it('rejects a snapshot that belongs to a different analysis', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // The snapshot's own configHash disagrees with the revision it is being filed under.
    const { response } = await uploadSnapshot(user, revisionId, { configHash: 'c'.repeat(64) })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }
    expect(body.error.code).toBe('SNAPSHOT_INVALID')
    expect(body.error.details?.reason).toBe('does_not_match_revision')
  })
})

describe('quota enforcement', () => {
  it('lets only one of two simultaneous uploads take the last of the space', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const size = await snapshotSize()

    // Room for one snapshot and change, but not for two.
    await apiFetch('/api/v1/me', { cookie: user.cookie })
    await setLimit(admin, user.userId, Math.floor(size * 1.5))

    const runId = await createRun(user)
    const first = await createRevision(user, runId, { configHash: CONFIG_HASH })
    const second = await createRevision(user, runId, { configHash: 'd'.repeat(64) })

    const [a, b] = await Promise.all([
      uploadSnapshot(user, first),
      uploadSnapshot(user, second, { configHash: 'd'.repeat(64) }),
    ])

    const statuses = [a.response.status, b.response.status].sort()
    expect(statuses).toEqual([201, 429])

    const rejected = a.response.status === 429 ? a.response : b.response
    const body = (await rejected.json()) as { error: { code: string } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.bytesUsed).toBeLessThanOrEqual(quota.bytesLimit)
    expect(quota.bytesReserved).toBe(0)
  })

  it('does not believe a falsified content length', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // Declares 64 bytes, sends kilobytes. The reservation is taken against the declaration and the
    // read is cut off at it, so the lie buys nothing.
    const { response } = await uploadSnapshot(user, revisionId, { declaredBytes: 64 })
    expect(response.status).toBe(429)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('QUOTA_EXCEEDED')

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(0)
    expect(quota.bytesReserved).toBe(0)

    // Nothing was written to R2 either.
    const objects = await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, user.userId))
    expect(objects).toHaveLength(0)
  })

  it('reclaims an aborted upload and deletes the object it orphaned', async () => {
    const user = await createUser()
    await apiFetch('/api/v1/me', { cookie: user.cookie })

    // An upload that died mid-flight: a pending reservation, past its expiry, and bytes in R2 that
    // no cloud_objects row claims.
    const orphanKey = `snapshots/${user.userId}/${newId()}/${newId()}.json`
    await env.AAT_OBJECTS.put(orphanKey, new Uint8Array(512))
    await db()
      .update(quotaUsage)
      .set({ bytesReserved: 4096, updatedAt: new Date() })
      .where(eq(quotaUsage.userId, user.userId))
    await db()
      .insert(quotaReservations)
      .values({
        id: newId(),
        userId: user.userId,
        bytes: 4096,
        purpose: 'snapshot',
        r2Key: orphanKey,
        status: 'pending',
        createdAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 1_800_000),
      })

    expect((await quotaOf(user)).bytesReserved).toBe(4096)

    // The sweeper runs on the upload path, which is exactly when quota pressure is real.
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const { response, size } = await uploadSnapshot(user, revisionId)
    expect(response.status).toBe(201)

    const quota = await quotaOf(user)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.bytesUsed).toBe(size)
    expect(await env.AAT_OBJECTS.get(orphanKey)).toBeNull()

    const reservations = await db()
      .select()
      .from(quotaReservations)
      .where(and(eq(quotaReservations.userId, user.userId), eq(quotaReservations.status, 'pending')))
    expect(reservations).toHaveLength(0)
  })

  it('gives the space back when the run is deleted', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const { size } = await uploadSnapshot(user, revisionId)

    const [object] = await db()
      .select()
      .from(cloudObjects)
      .where(eq(cloudObjects.ownerUserId, user.userId))
      .limit(1)
    expect(object?.byteSize).toBe(size)
    expect(await env.AAT_OBJECTS.get(object?.r2Key ?? '')).not.toBeNull()

    const deleted = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    expect(deleted.status).toBe(200)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(0)
    expect(quota.objectCount).toBe(0)
    // Soft-deleted metadata, hard-deleted bytes: a "deleted" run that still costs storage is a
    // bill nobody can explain.
    expect(await env.AAT_OBJECTS.get(object?.r2Key ?? '')).toBeNull()
  })

  it('refuses a snapshot larger than the configured maximum before reserving anything', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const query = new URLSearchParams({
      declaredBytes: String(10_000_000),
      sha256: 'a'.repeat(64),
      format: 'json',
    })
    const response = await apiFetch(`/api/v1/revisions/${revisionId}/snapshot?${query}`, {
      method: 'PUT',
      cookie: user.cookie,
      body: new Uint8Array(16) as BodyInit,
    })
    expect(response.status).toBe(413)

    const quota = await quotaOf(user)
    expect(quota.bytesReserved).toBe(0)
  })
})
