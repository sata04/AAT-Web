import { columnMappingHash, gzipCompress, gzipDecompress, sha256Hex } from '@aat/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { type Database, getDatabase } from '../../worker/db/client.ts'
import { analysisRevisions, cloudObjects, quotaReservations } from '../../worker/db/schema.ts'
import { newId } from '../../worker/lib/ids.ts'
import {
  commitUploadedObject,
  ensureQuotaRow,
  finaliseReservation,
  getQuotaState,
  reserveQuota,
  setQuotaLimit,
  sweepStaleReservations,
  unwindUploadedObject,
} from '../../worker/services/quota.ts'
import { interceptD1 } from './helpers/intercept-d1.ts'
import { buildSnapshot, encodeForUpload, TEST_COLUMN_MAPPING } from './helpers/snapshot.ts'

interface Fixture {
  env: Env
  db: Database
  userId: string
  fetch: (path: string, init?: RequestInit) => Promise<Response> | Response
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function createRun(f: Fixture) {
  const response = await f.fetch('/api/v1/runs', json('POST', { originalFilename: '260811a_data.csv' }))
  expect(response.status).toBe(201)
  return ((await response.json()) as { run: { id: string } }).run.id
}

async function revisionBody() {
  return {
    sourceSha256: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    mappingHash: await columnMappingHash(TEST_COLUMN_MAPPING),
    config: {},
    engineVersion: '1.0.0',
    snapshotFormatVersion: 1,
    metrics: {
      windowSize: 0.1,
      inner: { mean: 1, std: 0, startTime: 0 },
      drag: { mean: null, std: null, startTime: null },
      innerSampleCount: 1,
      dragSampleCount: 0,
    },
  }
}

async function createRevision(f: Fixture, runId: string) {
  const response = await f.fetch(`/api/v1/runs/${runId}/revisions`, json('POST', await revisionBody()))
  expect(response.status).toBe(201)
  return ((await response.json()) as { revision: { id: string } }).revision.id
}

async function snapshotBytes(paddingBytes = 0) {
  return (
    await encodeForUpload(
      buildSnapshot({ sourceSha256: 'a'.repeat(64), configHash: 'b'.repeat(64), paddingBytes }),
    )
  ).bytes
}

async function putSnapshot(f: Fixture, revisionId: string, bytes: Uint8Array, format = 'json') {
  const query = new URLSearchParams({
    declaredBytes: String(bytes.length),
    sha256: await sha256Hex(bytes),
    format,
  })
  return f.fetch(`/api/v1/revisions/${revisionId}/snapshot?${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as BodyInit,
  })
}

async function putSource(f: Fixture, runId: string, text: string) {
  const bytes = new TextEncoder().encode(text)
  const query = new URLSearchParams({
    declaredBytes: String(bytes.length),
    sha256: await sha256Hex(bytes),
    filename: 'source.csv',
  })
  return f.fetch(`/api/v1/runs/${runId}/source?${query}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/csv', 'x-aat-source-backup': 'requested-by-user' },
    body: bytes as BodyInit,
  })
}

/** Bind untouched methods to the native R2 receiver while controlling only the operation under test. */
function controlBucket(bucket: R2Bucket, overrides: Partial<Pick<R2Bucket, 'put' | 'delete'>>) {
  return new Proxy(bucket, {
    get(target, key) {
      const override = overrides[key as keyof typeof overrides]
      if (override) return override
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function gatePuts(f: Fixture) {
  const bucket = f.env.AAT_OBJECTS
  let arrived = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  f.env.AAT_OBJECTS = controlBucket(bucket, {
    put: (async (...args: Parameters<R2Bucket['put']>) => {
      const result = await bucket.put(...args)
      if (++arrived === 2) release()
      await gate
      return result
    }) as R2Bucket['put'],
  })
}

async function pendingObject(f: Fixture, runId: string, key: string, now = new Date()) {
  const reservation = await reserveQuota(f.db, f.userId, 100, 'source', key, 10, now)
  const bytes = new Uint8Array(100).fill(7)
  const object = {
    id: newId(),
    ownerUserId: f.userId,
    kind: 'source',
    r2Key: key,
    byteSize: bytes.length,
    sha256: await sha256Hex(bytes),
    contentType: 'text/csv',
    runId,
    reservationId: reservation.id,
    createdAt: now,
  }
  await f.db.insert(cloudObjects).values(object)
  await f.env.AAT_OBJECTS.put(key, bytes, { sha256: object.sha256 })
  return { reservation, object, bytes }
}

export function storageIntegrityCases(makeFixture: () => Promise<Fixture>) {
  async function fixture() {
    const f = await makeFixture()
    await ensureQuotaRow(f.db, f.userId, 1024 * 1024)
    return f
  }

  describe('storage integrity regressions', () => {
    for (const operation of ['reservation insert', 'ledger update'] as const) {
      it(`WORKER-007 rolls admission back after a failed ${operation}`, async () => {
        const f = await fixture()
        const table = operation === 'reservation insert' ? 'quota_reservations' : 'quota_usage'
        const event = operation === 'reservation insert' ? 'INSERT' : 'UPDATE'
        await f.env.DB.prepare(`CREATE TRIGGER fail_storage_admission BEFORE ${event} ON ${table}
          WHEN NEW.user_id = '${f.userId}' BEGIN SELECT RAISE(ABORT, 'injected admission failure'); END`).run()
        try {
          await expect(
            reserveQuota(f.db, f.userId, 100, 'source', `sources/${newId()}`, 900),
          ).rejects.toThrow()
        } finally {
          await f.env.DB.exec('DROP TRIGGER fail_storage_admission')
        }
        expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 0, bytesReserved: 0 })
        expect(
          await f.db.select().from(quotaReservations).where(eq(quotaReservations.userId, f.userId)),
        ).toHaveLength(0)
      })
    }

    it('WORKER-009 includes admitted reservations in a limit reduction', async () => {
      const f = await fixture()
      const reservation = await reserveQuota(f.db, f.userId, 200, 'source', `sources/${newId()}`, 900)
      await expect(setQuotaLimit(f.db, f.userId, 100)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      expect(await setQuotaLimit(f.db, f.userId, 200)).toMatchObject({ bytesLimit: 200, bytesReserved: 200 })
      await finaliseReservation(f.db, reservation, 200, f.userId)
      await expect(setQuotaLimit(f.db, f.userId, 100)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesLimit: 200,
        bytesUsed: 200,
        bytesReserved: 0,
      })
    })

    it('WORKER-009 cannot race admission to lower the limit below admitted bytes', async () => {
      const f = await fixture()
      const outcomes = await Promise.allSettled([
        reserveQuota(f.db, f.userId, 200, 'source', `sources/${newId()}`, 900),
        setQuotaLimit(f.db, f.userId, 100),
      ])
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      const state = await getQuotaState(f.db, f.userId)
      expect(state).not.toBeNull()
      expect((state?.bytesUsed ?? 0) + (state?.bytesReserved ?? 0)).toBeLessThanOrEqual(
        state?.bytesLimit ?? 0,
      )
    })

    it('WORKER-001 preserves replacement B when swept upload A resumes at the same legacy key', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const key = `sources/${f.userId}/${runId}/legacy.csv`
      const a = await pendingObject(f, runId, key, new Date(0))
      await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
      const b = await pendingObject(f, runId, key)
      await commitUploadedObject(f.db, f.env.AAT_OBJECTS, b.object, b.reservation, runId)
      await expect(
        commitUploadedObject(f.db, f.env.AAT_OBJECTS, a.object, a.reservation, runId),
      ).rejects.toMatchObject({ code: 'INTERNAL' })
      // Upload handlers also attempt an unwind after commit throws; that must be harmless too.
      await unwindUploadedObject(f.db, f.env.AAT_OBJECTS, a.object)
      const download = await f.fetch(`/api/v1/runs/${runId}/source`)
      expect(download.status).toBe(200)
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(b.bytes)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesUsed: 100,
        objectCount: 1,
        bytesReserved: 0,
      })
    })

    it('WORKER-008 retains the row after R2 deletion fails, and a later sweep reclaims it', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const { object, reservation } = await pendingObject(f, runId, `sources/${f.userId}/${newId()}`)
      await commitUploadedObject(f.db, f.env.AAT_OBJECTS, object, reservation, runId)
      const broken = controlBucket(f.env.AAT_OBJECTS, {
        delete: async () => {
          throw new Error('R2 unavailable')
        },
      })
      await expect(unwindUploadedObject(f.db, broken, object)).rejects.toThrow('R2 unavailable')
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.id, object.id))).toHaveLength(1)
      expect(await f.env.AAT_OBJECTS.get(object.r2Key)).not.toBeNull()
      await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
      expect(await f.env.AAT_OBJECTS.get(object.r2Key)).toBeNull()
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.id, object.id))).toHaveLength(0)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesUsed: 0,
        objectCount: 0,
        bytesReserved: 0,
      })
    })

    it('WORKER-008 retries failed R2 cleanup even when only the reservation remains', async () => {
      const f = await fixture()
      const key = `sources/${f.userId}/${newId()}`
      await reserveQuota(f.db, f.userId, 100, 'source', key, 1, new Date(0))
      await f.env.AAT_OBJECTS.put(key, new Uint8Array(100))
      const broken = controlBucket(f.env.AAT_OBJECTS, {
        delete: async () => {
          throw new Error('R2 unavailable')
        },
      })
      await expect(sweepStaleReservations(f.db, broken, new Date(), 10000)).rejects.toThrow('R2 unavailable')
      await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
      expect(await f.env.AAT_OBJECTS.get(key)).toBeNull()
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesReserved: 0, bytesUsed: 0 })
    })

    it.each(['source', 'snapshot'] as const)(
      'deletes a late %s PUT after expiry swept its row',
      async (kind) => {
        const f = await fixture()
        const runId = await createRun(f)
        const revisionId = await createRevision(f, runId)
        const bucket = f.env.AAT_OBJECTS
        let entered = () => {}
        let resume = () => {}
        const arrived = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          resume = resolve
        })
        f.env.AAT_OBJECTS = controlBucket(bucket, {
          put: async (...args: Parameters<R2Bucket['put']>) => {
            entered()
            await gate
            return bucket.put(...args)
          },
        })
        const upload =
          kind === 'source' ? putSource(f, runId, 'late') : putSnapshot(f, revisionId, await snapshotBytes())
        await arrived
        const [object] = await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))
        if (!object) throw new Error('missing staged object')
        try {
          await f.db
            .update(quotaReservations)
            .set({ expiresAt: new Date(0) })
            .where(eq(quotaReservations.userId, f.userId))
          await sweepStaleReservations(f.db, bucket, new Date(), 10000)
          expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.id, object.id))).toHaveLength(0)
        } finally {
          resume()
        }
        expect((await upload).status).toBe(500)
        expect(await bucket.head(object.r2Key)).toBeNull()
        expect(await getQuotaState(f.db, f.userId)).toMatchObject({
          bytesUsed: 0,
          bytesReserved: 0,
          objectCount: 0,
        })
      },
    )

    it('reclaims a finalised snapshot after publication AND accounting cleanup fail, before retrying', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const revisionId = await createRevision(f, runId)
      const bytes = await snapshotBytes()
      await f.env.DB.prepare(`CREATE TRIGGER fail_snapshot_publish BEFORE UPDATE OF snapshot_object_id ON analysis_revisions
        WHEN NEW.id = '${revisionId}' AND NEW.snapshot_object_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`).run()
      await f.env.DB.prepare(`CREATE TRIGGER fail_snapshot_unwind BEFORE UPDATE ON quota_reservations
        WHEN NEW.user_id = '${f.userId}' AND NEW.status = 'settled'
        BEGIN SELECT RAISE(ABORT, 'injected accounting failure'); END`).run()
      try {
        expect((await putSnapshot(f, revisionId, bytes)).status).toBe(500)
      } finally {
        await f.env.DB.exec('DROP TRIGGER fail_snapshot_publish')
        await f.env.DB.exec('DROP TRIGGER fail_snapshot_unwind')
      }
      const [abandoned] = await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))
      if (!abandoned) throw new Error('missing recovery record')
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: bytes.length, objectCount: 1 })
      // Physical cleanup does not depend on successful D1 settlement.
      expect(await f.env.AAT_OBJECTS.head(abandoned.r2Key)).toBeNull()
      await f.db
        .update(quotaReservations)
        .set({ expiresAt: new Date(0) })
        .where(eq(quotaReservations.userId, f.userId))
      expect((await putSnapshot(f, revisionId, bytes)).status).toBe(201)
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))).toHaveLength(1)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesUsed: bytes.length,
        bytesReserved: 0,
        objectCount: 1,
      })
      // A live, finalised snapshot must survive even after its reservation expires.
      await f.db
        .update(quotaReservations)
        .set({ expiresAt: new Date(0) })
        .where(eq(quotaReservations.userId, f.userId))
      await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
      expect((await f.fetch(`/api/v1/revisions/${revisionId}/snapshot`)).status).toBe(200)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: bytes.length, objectCount: 1 })
    })

    it.each(['snapshot', 'poster'] as const)(
      'reclaims a charged, unpublished %s after isolate eviction',
      async (kind) => {
        const f = await fixture()
        const runId = await createRun(f)
        const revisionId = await createRevision(f, runId)
        const upload = await pendingObject(f, runId, `${kind}/${f.userId}/${newId()}`, new Date(0))
        await f.db
          .update(cloudObjects)
          .set({ kind, analysisRevisionId: revisionId })
          .where(eq(cloudObjects.id, upload.object.id))
        await finaliseReservation(f.db, upload.reservation, upload.bytes.length, f.userId)
        // Eviction means no handler catch/finally runs after finalisation.
        await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
        expect(await f.env.AAT_OBJECTS.head(upload.object.r2Key)).toBeNull()
        expect(
          await f.db.select().from(cloudObjects).where(eq(cloudObjects.id, upload.object.id)),
        ).toHaveLength(0)
        expect(await getQuotaState(f.db, f.userId)).toMatchObject({
          bytesUsed: 0,
          bytesReserved: 0,
          objectCount: 0,
        })
      },
    )

    it('does not publish a snapshot reclaimed between finalisation and publication', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const revisionId = await createRevision(f, runId)
      let swept = false
      f.env.DB = interceptD1(f.env.DB, async (sql, phase) => {
        if (
          !swept &&
          phase === 'before' &&
          sql.startsWith('update "analysis_revisions" set "snapshot_object_id"')
        ) {
          swept = true
          await f.db
            .update(quotaReservations)
            .set({ expiresAt: new Date(0) })
            .where(eq(quotaReservations.userId, f.userId))
          await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
        }
      })
      expect((await putSnapshot(f, revisionId, await snapshotBytes())).status).toBe(422)
      expect(swept).toBe(true)
      const [revision] = await f.db
        .select()
        .from(analysisRevisions)
        .where(eq(analysisRevisions.id, revisionId))
      expect(revision?.snapshotObjectId).toBeNull()
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 0, objectCount: 0 })
      expect((await putSnapshot(f, revisionId, await snapshotBytes())).status).toBe(201)
    })

    it('WORKER-002 bounds decoded gzip bytes and preserves existing unbounded callers', async () => {
      const bytes = new Uint8Array(2 * 1024 * 1024)
      const compressed = await gzipCompress(bytes)
      expect(compressed.length).toBeLessThan(4096)
      await expect(gzipDecompress(compressed, 1024 * 1024)).rejects.toBeInstanceOf(RangeError)
      expect(await gzipDecompress(compressed, bytes.length)).toEqual(bytes)
      expect(await gzipDecompress(await gzipCompress(new Uint8Array([1, 2, 3])))).toEqual(
        new Uint8Array([1, 2, 3]),
      )
    })

    it('WORKER-002 rejects an oversized decoded snapshot before parsing or publishing', async () => {
      const f = await fixture()
      const revisionId = await createRevision(f, await createRun(f))
      const compressed = await gzipCompress(new Uint8Array(2 * 1024 * 1024))
      const response = await putSnapshot(f, revisionId, compressed, 'json.gz')
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({
        error: { code: 'EXPORT_TOO_LARGE', details: { maxDecodedBytes: 1024 * 1024 } },
      })
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 0, bytesReserved: 0 })
      expect(
        await f.db.select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, f.userId)),
      ).toHaveLength(0)
    })

    it('WORKER-010 publishes one immutable winner across concurrent JSON and gzip uploads', async () => {
      const f = await fixture()
      const revisionId = await createRevision(f, await createRun(f))
      gatePuts(f)
      const responses = await Promise.all([
        putSnapshot(f, revisionId, await snapshotBytes()),
        putSnapshot(f, revisionId, await gzipCompress(await snapshotBytes(20)), 'json.gz'),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([201, 422])
      const winner = (await responses.find((response) => response.status === 201)?.json()) as {
        object: { id: string; byteSize: number }
      }
      const [revision] = await f.db
        .select()
        .from(analysisRevisions)
        .where(eq(analysisRevisions.id, revisionId))
      expect(revision?.snapshotObjectId).toBe(winner.object.id)
      expect(
        await f.db.select().from(cloudObjects).where(eq(cloudObjects.analysisRevisionId, revisionId)),
      ).toHaveLength(1)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesUsed: winner.object.byteSize,
        objectCount: 1,
        bytesReserved: 0,
      })
      expect((await f.fetch(`/api/v1/revisions/${revisionId}/snapshot`)).status).toBe(200)
    })

    it('WORKER-010 answers concurrent byte-identical snapshot retries with the winning object', async () => {
      const f = await fixture()
      const revisionId = await createRevision(f, await createRun(f))
      const bytes = await snapshotBytes()
      gatePuts(f)
      const responses = await Promise.all([
        putSnapshot(f, revisionId, bytes),
        putSnapshot(f, revisionId, bytes),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 201])
      const bodies = (await Promise.all(responses.map((response) => response.json()))) as {
        object: { id: string }
      }[]
      expect(bodies[0]?.object.id).toBe(bodies[1]?.object.id)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: bytes.length, objectCount: 1 })
    })

    it('WORKER-011 retries identical sources without charging again and replaces different content', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const first = await putSource(f, runId, 'a,b\n1,2\n')
      expect(first.status).toBe(201)
      const firstBody = await first.json()
      const retry = await putSource(f, runId, 'a,b\n1,2\n')
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual(firstBody)
      const replacement = 'a,b\n30,40\n'
      expect((await putSource(f, runId, replacement)).status).toBe(201)
      expect(await (await f.fetch(`/api/v1/runs/${runId}/source`)).text()).toBe(replacement)
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))).toHaveLength(1)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({
        bytesUsed: replacement.length,
        objectCount: 1,
        bytesReserved: 0,
      })
    })

    it('WORKER-011 reconciles duplicate sources from older deployments on an identical retry', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      for (let index = 0; index < 2; index++) {
        const upload = await pendingObject(f, runId, `sources/${f.userId}/${newId()}`)
        await commitUploadedObject(f.db, f.env.AAT_OBJECTS, upload.object, upload.reservation, runId)
      }
      const response = await putSource(f, runId, String.fromCharCode(7).repeat(100))
      expect(response.status).toBe(200)
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))).toHaveLength(1)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 100, objectCount: 1 })
    })

    for (const identical of [true, false]) {
      it(`WORKER-011 retains one live source during concurrent ${identical ? 'identical' : 'different'} PUTs`, async () => {
        const f = await fixture()
        const runId = await createRun(f)
        gatePuts(f)
        const responses = await Promise.all([
          putSource(f, runId, 'first'),
          putSource(f, runId, identical ? 'first' : 'second'),
        ])
        expect(responses.map((response) => response.status).sort()).toEqual(
          identical ? [200, 201] : [201, 201],
        )
        const live = await f.db
          .select()
          .from(cloudObjects)
          .where(and(eq(cloudObjects.runId, runId), isNull(cloudObjects.deletedAt)))
        expect(live).toHaveLength(1)
        const download = await f.fetch(`/api/v1/runs/${runId}/source`)
        expect(['first', 'second']).toContain(await download.text())
        expect(await getQuotaState(f.db, f.userId)).toMatchObject({
          bytesUsed: live[0]?.byteSize,
          objectCount: 1,
          bytesReserved: 0,
        })
      })
    }

    it('WORKER-011 keeps failed replacement cleanup discoverable without hiding the new source', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      await putSource(f, runId, 'old')
      const bucket = f.env.AAT_OBJECTS
      f.env.AAT_OBJECTS = controlBucket(bucket, {
        delete: async () => {
          throw new Error('R2 unavailable')
        },
      })
      expect((await putSource(f, runId, 'new source')).status).toBe(201)
      expect(await (await f.fetch(`/api/v1/runs/${runId}/source`)).text()).toBe('new source')
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))).toHaveLength(2)
      f.env.AAT_OBJECTS = bucket
      await sweepStaleReservations(f.db, bucket, new Date(), 10000)
      expect(await f.db.select().from(cloudObjects).where(eq(cloudObjects.runId, runId))).toHaveLength(1)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 10, objectCount: 1 })
    })

    it('WORKER-012 rolls back the revision identity when its metrics fail, allowing a complete retry', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      await f.env.DB.prepare(`CREATE TRIGGER fail_storage_metrics BEFORE INSERT ON analysis_metrics
        WHEN EXISTS (SELECT 1 FROM analysis_revisions WHERE id = NEW.analysis_revision_id AND run_id = '${runId}')
        BEGIN SELECT RAISE(ABORT, 'injected metrics failure'); END`).run()
      try {
        const failed = await f.fetch(`/api/v1/runs/${runId}/revisions`, json('POST', await revisionBody()))
        expect(failed.status).toBe(500)
        expect(
          await f.db.select().from(analysisRevisions).where(eq(analysisRevisions.runId, runId)),
        ).toHaveLength(0)
      } finally {
        await f.env.DB.exec('DROP TRIGGER fail_storage_metrics')
      }
      const revisionId = await createRevision(f, runId)
      const detail = await f.fetch(`/api/v1/revisions/${revisionId}`)
      expect(await detail.json()).toMatchObject({ metrics: { inner: { mean: 1 } } })
    })

    it('WORKER-019 rolls the memo and tags back together after a failed tag insert', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      await f.fetch(`/api/v1/runs/${runId}`, json('PATCH', { memo: 'original', tags: ['old'] }))
      await f.env.DB.prepare(`CREATE TRIGGER fail_storage_tags BEFORE INSERT ON run_tags
        WHEN NEW.run_id = '${runId}' BEGIN SELECT RAISE(ABORT, 'injected tag failure'); END`).run()
      try {
        expect(
          (await f.fetch(`/api/v1/runs/${runId}`, json('PATCH', { memo: 'changed', tags: ['new'] }))).status,
        ).toBe(500)
      } finally {
        await f.env.DB.exec('DROP TRIGGER fail_storage_tags')
      }
      expect(await (await f.fetch(`/api/v1/runs/${runId}`)).json()).toMatchObject({
        run: { memo: 'original', tags: ['old'] },
      })
    })

    it('WORKER-019 concurrent replaces leave exactly one requested memo and tag set', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const responses = await Promise.all([
        f.fetch(`/api/v1/runs/${runId}`, json('PATCH', { memo: 'A', tags: ['A'] })),
        f.fetch(`/api/v1/runs/${runId}`, json('PATCH', { memo: 'B', tags: ['B'] })),
      ])
      expect(responses.map((response) => response.status)).toEqual([200, 200])
      const detail = (await (await f.fetch(`/api/v1/runs/${runId}`)).json()) as {
        run: { memo: string; tags: string[] }
      }
      expect(['A', 'B']).toContain(detail.run.memo)
      expect(detail.run.tags).toEqual([detail.run.memo])
      expect((await f.fetch(`/api/v1/runs/${runId}`, json('PATCH', { tags: [] }))).status).toBe(200)
      expect(await (await f.fetch(`/api/v1/runs/${runId}`)).json()).toMatchObject({ run: { tags: [] } })
    })

    it('does not sweep a staged source that published after the cleanup scan', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const upload = await pendingObject(f, runId, `sources/${f.userId}/${newId()}`, new Date(0))
      await f.db
        .update(cloudObjects)
        .set({ deletedAt: new Date(0) })
        .where(eq(cloudObjects.id, upload.object.id))
      await finaliseReservation(f.db, upload.reservation, 100, f.userId)
      let published = false
      const database = interceptD1(f.env.DB, async (sql, phase) => {
        if (phase === 'after' && sql.includes('left join "quota_reservations"')) {
          await f.db
            .update(cloudObjects)
            .set({ deletedAt: null })
            .where(eq(cloudObjects.id, upload.object.id))
          published = true
        }
      })
      await sweepStaleReservations(
        getDatabase({ ...f.env, DB: database }),
        f.env.AAT_OBJECTS,
        new Date(),
        10000,
      )
      expect(published).toBe(true)
      expect((await f.fetch(`/api/v1/runs/${runId}/source`)).status).toBe(200)
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 100, objectCount: 1 })
    })

    it('unpublished source tombstones are reclaimed after their reservation expiry', async () => {
      const f = await fixture()
      const runId = await createRun(f)
      const upload = await pendingObject(f, runId, `sources/${f.userId}/${newId()}`, new Date(0))
      await f.db
        .update(cloudObjects)
        .set({ deletedAt: new Date(0) })
        .where(eq(cloudObjects.id, upload.object.id))
      await finaliseReservation(f.db, upload.reservation, 100, f.userId)
      await sweepStaleReservations(f.db, f.env.AAT_OBJECTS, new Date(), 10000)
      expect(await f.env.AAT_OBJECTS.get(upload.object.r2Key)).toBeNull()
      expect(await getQuotaState(f.db, f.userId)).toMatchObject({ bytesUsed: 0, objectCount: 0 })
    })
  })
}
