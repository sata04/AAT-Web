/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Storage quotas, and the accounting that has to survive concurrency and lying clients.
 *
 * The four cases here are the ones a naive "check, write, add" implementation gets wrong:
 * two uploads racing for the last byte, a falsified size, an upload that never finishes, and a
 * deletion that has to give the space back.
 */

import { env } from 'cloudflare:test'
import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { analysisRevisions, cloudObjects, quotaReservations, quotaUsage } from '../../worker/db/schema.ts'
import { newId } from '../../worker/lib/ids.ts'
import {
  finaliseReservation,
  releaseObjectAccounting,
  sweepStaleReservations,
  unwindUploadedObject,
} from '../../worker/services/quota.ts'
import { apiFetch, createRevision, createRun, createUser, db, type TestUser } from './helpers/client.ts'
import {
  buildSnapshot,
  encodeForUpload,
  TEST_COLUMN_MAPPING,
  type TestColumnMapping,
} from './helpers/snapshot.ts'

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
  columnMapping?: TestColumnMapping | null
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
    ...(options.columnMapping === undefined ? {} : { columnMapping: options.columnMapping }),
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

/** SHA-256 hex of `bytes`, the way the upload endpoints demand it. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** PUT /api/v1/runs/:runId/source — the opt-in raw-CSV backup path. */
async function uploadSource(user: TestUser, runId: string, bytes: Uint8Array): Promise<Response> {
  const query = new URLSearchParams({
    declaredBytes: String(bytes.length),
    sha256: await sha256Hex(bytes),
    filename: 'src.csv',
  })
  return apiFetch(`/api/v1/runs/${runId}/source?${query}`, {
    method: 'PUT',
    cookie: user.cookie,
    headers: {
      'content-type': 'text/csv',
      // The backup is opt-in: the upload is refused without the explicit request marker.
      'x-aat-source-backup': 'requested-by-user',
    },
    body: bytes as BodyInit,
  })
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

  it('rejects a snapshot whose column mapping is not the revision identity', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // The revision's mappingHash was minted from TEST_COLUMN_MAPPING; a snapshot that declares a
    // different mapping cannot be filed under it — the same bytes under different columns are a
    // different analysis.
    const { response } = await uploadSnapshot(user, revisionId, {
      columnMapping: { ...TEST_COLUMN_MAPPING, dragColumn: 'NotTheDragColumn' },
    })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }
    expect(body.error.code).toBe('SNAPSHOT_INVALID')
    expect(body.error.details?.reason).toBe('mapping_mismatch')
  })

  it('rejects a snapshot that does not declare a column mapping at all', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const { response } = await uploadSnapshot(user, revisionId, { columnMapping: null })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }
    expect(body.error.code).toBe('SNAPSHOT_INVALID')
    expect(body.error.details?.reason).toBe('mapping_mismatch')
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

  it('releases nothing when a run delete is retried', async () => {
    const user = await createUser()
    const runA = await createRun(user)
    const revisionA = await createRevision(user, runA)
    await uploadSnapshot(user, revisionA)

    // A sibling run keeps real usage on the account: a delete that released the first run's
    // bytes a second time would subtract below what is actually stored, not just clamp at zero.
    const runB = await createRun(user, '260812a_data.csv')
    const revisionB = await createRevision(user, runB)
    const { size } = await uploadSnapshot(user, revisionB)

    const first = await apiFetch(`/api/v1/runs/${runA}`, { method: 'DELETE', cookie: user.cookie })
    expect(first.status).toBe(200)
    const second = await apiFetch(`/api/v1/runs/${runA}`, { method: 'DELETE', cookie: user.cookie })
    expect(second.status).toBe(200)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.objectCount).toBe(1)
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

  it('releases quota exactly once when two source deletes race', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // A snapshot alongside the source: if a racing delete subtracted the source's bytes twice,
    // this is the usage figure it would eat into — the clamp at zero would hide a single
    // over-release but cannot hide one that consumes a second object's accounting.
    const { size } = await uploadSnapshot(user, revisionId)
    expect(size).toBeGreaterThan(8)

    const sourceBytes = new TextEncoder().encode('a,b\n1,2\n')
    const uploaded = await uploadSource(user, runId, sourceBytes)
    expect(uploaded.status).toBe(201)
    expect((await quotaOf(user)).bytesUsed).toBe(size + sourceBytes.length)

    const [a, b] = await Promise.all([
      apiFetch(`/api/v1/runs/${runId}/source`, { method: 'DELETE', cookie: user.cookie }),
      apiFetch(`/api/v1/runs/${runId}/source`, { method: 'DELETE', cookie: user.cookie }),
    ])
    expect([a.status, b.status]).toEqual([200, 200])

    // The tombstone is the claim: exactly one delete owns the transition, so the reported count
    // is the truth and the bytes are subtracted once — not once per request.
    const deletedCounts = [
      ((await a.json()) as { objectsDeleted: number }).objectsDeleted,
      ((await b.json()) as { objectsDeleted: number }).objectsDeleted,
    ]
    expect(deletedCounts.reduce((sum, count) => sum + count, 0)).toBe(1)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.objectCount).toBe(1)
  })

  it('does not release usage for an object whose reservation the sweeper already claimed', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // The charged baseline lives under a second run so it survives the delete: without it a
    // wrongful release is invisible because bytesUsed clamps at zero.
    const survivorRunId = await createRun(user, '260812a_data.csv')
    const survivorRevisionId = await createRevision(user, survivorRunId)
    const { size } = await uploadSnapshot(user, survivorRevisionId)
    expect((await quotaOf(user)).bytesUsed).toBe(size)

    // An upload that got as far as inserting its object row but whose reservation lapsed before
    // commit: the sweeper releases the reservation — and leaves the row when the row claims the
    // key — so the object sits there never having charged usage.
    const key = `snapshots/${user.userId}/${runId}/${newId()}.json`
    const reservationId = newId()
    await db()
      .insert(quotaReservations)
      .values({
        id: reservationId,
        userId: user.userId,
        bytes: 256,
        purpose: 'snapshot',
        r2Key: key,
        status: 'pending',
        createdAt: new Date(0),
        expiresAt: new Date(0),
      })
    await db()
      .insert(cloudObjects)
      .values({
        id: newId(),
        ownerUserId: user.userId,
        kind: 'snapshot',
        r2Key: key,
        byteSize: 256,
        sha256: 'c'.repeat(64),
        contentType: 'application/json',
        runId,
        analysisRevisionId: revisionId,
        reservationId,
        createdAt: new Date(),
      })
    const sweep = await sweepStaleReservations(db(), env.AAT_OBJECTS)
    expect(sweep.reservationsReleased).toBe(1)

    const deleted = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    expect(deleted.status).toBe(200)

    // The swept reservation charged nothing, so the delete must subtract nothing — releasing
    // usage here would take quota away from the surviving run's snapshot.
    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.bytesReserved).toBe(0)
  })

  it('releases the reservation — not usage — for an object deleted mid-upload', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // As above: a committed upload under another run keeps the ledger non-zero so a release from
    // the wrong side of it cannot hide behind the clamp.
    const survivorRunId = await createRun(user, '260812a_data.csv')
    const survivorRevisionId = await createRevision(user, survivorRunId)
    const { size } = await uploadSnapshot(user, survivorRevisionId)

    // The same mid-flight shape, but with the reservation still live: the deleter reaches it
    // before the sweeper does.
    const key = `snapshots/${user.userId}/${runId}/${newId()}.json`
    const reservationId = newId()
    await db()
      .insert(quotaReservations)
      .values({
        id: reservationId,
        userId: user.userId,
        bytes: 256,
        purpose: 'snapshot',
        r2Key: key,
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      })
    await db()
      .insert(cloudObjects)
      .values({
        id: newId(),
        ownerUserId: user.userId,
        kind: 'snapshot',
        r2Key: key,
        byteSize: 256,
        sha256: 'd'.repeat(64),
        contentType: 'application/json',
        runId,
        analysisRevisionId: revisionId,
        reservationId,
        createdAt: new Date(),
      })
    await db()
      .update(quotaUsage)
      .set({ bytesReserved: 256, updatedAt: new Date() })
      .where(eq(quotaUsage.userId, user.userId))

    const deleted = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    expect(deleted.status).toBe(200)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.bytesReserved).toBe(0)
  })

  it('lets a retried run delete finish cleaning up a tombstoned run', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    await uploadSnapshot(user, revisionId)

    const first = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    expect(first.status).toBe(200)

    // A delete that failed partway through its object walk lands here: the run is already
    // tombstoned, and without admission the retry would 404 while its objects stay charged.
    const retried = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    expect(retried.status).toBe(200)
    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(0)
    expect(quota.objectCount).toBe(0)
  })

  it('uncharges a settlement whose reservation was already claimed', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const { size } = await uploadSnapshot(user, revisionId)

    // Settle a reservation the sweeper already claimed: the charge lands, the pending→finalised
    // claim fails, and the unwind must restore the account exactly — reserved column included,
    // because the sweeper subtracted it as well.
    const reservationId = newId()
    const key = `snapshots/${user.userId}/${runId}/${newId()}.json`
    await db()
      .insert(quotaReservations)
      .values({
        id: reservationId,
        userId: user.userId,
        bytes: 256,
        purpose: 'snapshot',
        r2Key: key,
        status: 'pending',
        createdAt: new Date(0),
        expiresAt: new Date(0),
      })
    await db()
      .update(quotaUsage)
      .set({ bytesReserved: 256, updatedAt: new Date() })
      .where(eq(quotaUsage.userId, user.userId))
    await sweepStaleReservations(db(), env.AAT_OBJECTS)

    const settled = await finaliseReservation(
      db(),
      { id: reservationId, bytes: 256, purpose: 'snapshot', r2Key: key },
      256,
      user.userId,
      new Date(),
    )
    expect(settled).toBe(false)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.objectCount).toBe(1)
  })

  it('never orphans a committed object when its run is deleted mid-upload', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const encoded = await encodeForUpload(
      buildSnapshot({ sourceSha256: SOURCE_SHA, configHash: CONFIG_HASH }),
    )

    // Race the upload's commit against the run's delete. Which one lands first is timing, not
    // contract — the contract is what must hold afterwards either way.
    const query = new URLSearchParams({
      declaredBytes: String(encoded.bytes.length),
      sha256: encoded.sha256,
      format: 'json',
    })
    const upload = apiFetch(`/api/v1/revisions/${revisionId}/snapshot?${query}`, {
      method: 'PUT',
      cookie: user.cookie,
      headers: { 'content-type': 'application/json' },
      body: encoded.bytes as BodyInit,
    })
    const deleted = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: user.cookie })
    const response = await upload

    expect(deleted.status).toBe(200)
    // 404: the delete won and the upload unwound itself. 201: the commit landed inside the
    // delete's object walk and the delete reclaimed it. Both answers are honest.
    expect([201, 404]).toContain(response.status)

    // Whatever the order, the ledger agrees with reality: no live row, no bytes without one,
    // no charge for storage that is gone. (R2 is shared across the file, so the check is scoped
    // to this user's key prefix.)
    const live = await db()
      .select()
      .from(cloudObjects)
      .where(and(eq(cloudObjects.ownerUserId, user.userId), isNull(cloudObjects.deletedAt)))
    expect(live).toHaveLength(0)
    const stored = await env.AAT_OBJECTS.list({ prefix: `snapshots/${user.userId}/` })
    expect(stored.objects).toHaveLength(0)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(0)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.objectCount).toBe(0)
  })

  it('unwinds a committed upload whose bookkeeping failed, freeing its key for the retry', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const { response, size } = await uploadSnapshot(user, revisionId)
    expect(response.status).toBe(201)

    // A failure in the bookkeeping after commitUploadedObject — the snapshot pointer update, the
    // audit entry — leaves the row, the bytes and the settled charge all live while the client
    // saw an error and will retry. Rebuild that end state and take the catch path.
    const [object] = await db()
      .select()
      .from(cloudObjects)
      .where(eq(cloudObjects.analysisRevisionId, revisionId))
    if (!object?.reservationId) throw new Error('expected a committed object row')

    await unwindUploadedObject(db(), env.AAT_OBJECTS, {
      id: object.id,
      r2Key: object.r2Key,
      sha256: object.sha256,
      ownerUserId: object.ownerUserId,
      byteSize: object.byteSize,
      reservationId: object.reservationId,
    })

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(0)
    expect(quota.bytesReserved).toBe(0)
    expect(quota.objectCount).toBe(0)
    expect(await env.AAT_OBJECTS.get(object.r2Key)).toBeNull()

    // The retry the client would send — same key, same bytes — is the assertion that matters:
    // it can only succeed if the unwind cleared the unique-key obstacle as well as the charge.
    const retry = await uploadSnapshot(user, revisionId)
    expect(retry.response.status).toBe(201)
    expect(retry.size).toBe(size)
  })

  it('takes a key back from a wedged row whose unwind died mid-cleanup', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    const { size } = await uploadSnapshot(user, revisionId)

    // Rebuild the state an unwind crash leaves: the accounting is already terminal — settled and
    // uncharged — but the row still occupies the deterministic key, and the revision's pointer
    // was never written, which is why the client is retrying the upload at all.
    const [object] = await db()
      .select()
      .from(cloudObjects)
      .where(eq(cloudObjects.analysisRevisionId, revisionId))
    if (!object?.reservationId) throw new Error('expected a committed object row')
    await releaseObjectAccounting(db(), object)
    await db()
      .update(analysisRevisions)
      .set({ snapshotObjectId: null })
      .where(eq(analysisRevisions.id, revisionId))

    const wedged = await quotaOf(user)
    expect(wedged.bytesUsed).toBe(0)
    expect(wedged.objectCount).toBe(0)
    // …but the row and its bytes are still there, blocking the deterministic key.
    expect(await env.AAT_OBJECTS.get(object.r2Key)).not.toBeNull()

    const retry = await uploadSnapshot(user, revisionId)
    expect(retry.response.status).toBe(201)
    expect(retry.size).toBe(size)

    const quota = await quotaOf(user)
    expect(quota.bytesUsed).toBe(size)
    expect(quota.objectCount).toBe(1)

    const download = await apiFetch(`/api/v1/revisions/${revisionId}/snapshot`, { cookie: user.cookie })
    expect(download.status).toBe(200)
    expect((await download.arrayBuffer()).byteLength).toBe(size)
  })

  it('sweeps a dead object row and the bytes it still points at', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    await uploadSnapshot(user, revisionId)

    const [object] = await db()
      .select()
      .from(cloudObjects)
      .where(eq(cloudObjects.analysisRevisionId, revisionId))
    if (!object?.reservationId) throw new Error('expected a committed object row')
    await releaseObjectAccounting(db(), object)

    const swept = await sweepStaleReservations(db(), env.AAT_OBJECTS)
    expect(swept.deadRowsReclaimed).toBe(1)

    const [row] = await db().select().from(cloudObjects).where(eq(cloudObjects.id, object.id))
    expect(row).toBeUndefined()
    expect(await env.AAT_OBJECTS.get(object.r2Key)).toBeNull()
  })
})
