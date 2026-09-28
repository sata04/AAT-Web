import { env } from 'cloudflare:test'
import { specHash } from '@aat/plot-spec'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { cloudObjects, posterFigures, quotaReservations, quotaUsage } from '../../worker/db/schema.ts'
import { newId } from '../../worker/lib/ids.ts'
import { markRendered } from '../../worker/services/poster.ts'
import { reserveQuota, sweepStaleReservations } from '../../worker/services/quota.ts'
import { posterKey } from '../../worker/services/storage.ts'
import { apiFetch, createRevision, createRun, createUser, db, posterSpec } from './helpers/client.ts'

async function renderCount() {
  const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
  return ((await (await stub.fetch('http://renderer/count')).json()) as { count: number }).count
}

describe('poster admission', () => {
  it('rejects exhausted quota on generation and repeated retries without rendering', async () => {
    const user = await createUser()
    const revisionId = await createRevision(user, await createRun(user))
    await db().update(quotaUsage).set({ bytesLimit: 0 }).where(eq(quotaUsage.userId, user.userId))
    const before = await renderCount()
    const generated = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(generated.status).toBe(429)
    const [figure] = await db()
      .select()
      .from(posterFigures)
      .where(eq(posterFigures.analysisRevisionId, revisionId))
    expect(figure?.status).toBe('failed')
    for (let retry = 0; retry < 3; retry++) {
      const response = await apiFetch(`/api/v1/posters/${figure?.id}/retry`, {
        method: 'POST',
        cookie: user.cookie,
        body: JSON.stringify({ spec: posterSpec(revisionId) }),
      })
      expect(response.status).toBe(429)
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED')
    }
    expect(await renderCount()).toBe(before)
    const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
    expect(quota?.bytesReserved).toBe(0)
  })

  it.each(['custom', 'auto'] as const)(
    'admits one stale %s retry and replaces its attempt token',
    async (kind) => {
      const user = await createUser()
      const runId = await createRun(user)
      const revisionId = await createRevision(user, runId)
      const id = newId()
      const spec = posterSpec(revisionId, kind)
      const past = new Date(Date.now() - 600_000)
      await db()
        .insert(posterFigures)
        .values({
          id,
          analysisRevisionId: revisionId,
          ownerUserId: user.userId,
          kind,
          presetKey: 'aat-poster',
          presetVersion: spec.posterPresetVersion,
          specHash: 'a'.repeat(64),
          status: 'rendering',
          attemptCount: 1,
          renderAttempt: 'abandoned-attempt',
          startedAt: past,
          createdAt: past,
          updatedAt: past,
        })
      // An abandoned pre-upgrade attempt can still own the old figure-wide key. A retry must
      // store separately so cleaning up those bytes cannot delete the newly published poster.
      const oldKey = posterKey(user.userId, runId, revisionId, id)
      const reservationId = newId()
      await db().insert(quotaReservations).values({
        id: reservationId,
        userId: user.userId,
        bytes: 3,
        purpose: 'poster',
        r2Key: oldKey,
        status: 'released',
        createdAt: past,
        expiresAt: past,
      })
      await db()
        .insert(cloudObjects)
        .values({
          id: newId(),
          ownerUserId: user.userId,
          kind: 'poster',
          r2Key: oldKey,
          byteSize: 3,
          sha256: 'a'.repeat(64),
          contentType: 'image/png',
          runId,
          analysisRevisionId: revisionId,
          reservationId,
          createdAt: past,
        })
      await env.AAT_OBJECTS.put(oldKey, 'old')
      const before = await renderCount()
      const retry = () =>
        apiFetch(`/api/v1/posters/${id}/retry`, {
          method: 'POST',
          cookie: user.cookie,
          body: JSON.stringify({ spec }),
        })
      const responses = await Promise.all([retry(), retry()])
      expect(responses.map((response) => response.status).sort()).toEqual([201, 429])
      expect(await renderCount()).toBe(before + 1)
      const [figure] = await db().select().from(posterFigures).where(eq(posterFigures.id, id))
      expect(figure?.renderAttempt).not.toBe('abandoned-attempt')
      expect(figure?.attemptCount).toBe(2)
      expect(figure?.specHash).toBe(await specHash(spec))
      expect(await markRendered(db(), id, 'obsolete-object', 'renderer', 'abandoned-attempt')).toBe(false)
      await sweepStaleReservations(db(), env.AAT_OBJECTS)
      expect(await env.AAT_OBJECTS.head(oldKey)).toBeNull()
      const [published] = await db()
        .select()
        .from(cloudObjects)
        .where(eq(cloudObjects.id, figure?.objectId ?? ''))
      expect(published?.r2Key).not.toBe(oldKey)
      expect(await env.AAT_OBJECTS.head(published?.r2Key ?? '')).not.toBeNull()
      const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
      expect(quota?.bytesReserved).toBe(0)
      expect(quota?.bytesUsed).toBeGreaterThan(0)
      expect(quota?.bytesUsed).toBeLessThan(Number(env.AAT_MAX_POSTER_BYTES))
    },
  )

  it('sweeps an expired hold before admitting a poster retry', async () => {
    const user = await createUser()
    const revisionId = await createRevision(user, await createRun(user))
    const budget = Number(env.AAT_MAX_POSTER_BYTES)
    await db().update(quotaUsage).set({ bytesLimit: budget }).where(eq(quotaUsage.userId, user.userId))
    const held = await reserveQuota(
      db(),
      user.userId,
      budget,
      'poster',
      `posters/${user.userId}/expired`,
      900,
    )
    const request = {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    }
    expect((await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, request)).status).toBe(429)
    const [figure] = await db()
      .select()
      .from(posterFigures)
      .where(eq(posterFigures.analysisRevisionId, revisionId))
    await db()
      .update(quotaReservations)
      .set({ expiresAt: new Date(0) })
      .where(eq(quotaReservations.id, held.id))
    const before = await renderCount()
    expect((await apiFetch(`/api/v1/posters/${figure?.id}/retry`, request)).status).toBe(201)
    expect(await renderCount()).toBe(before + 1)
    const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
    expect(quota?.bytesReserved).toBe(0)
    expect(quota?.objectCount).toBe(1)
  })

  it('returns the reservation on renderer failure', async () => {
    const user = await createUser()
    const revisionId = await createRevision(user, await createRun(user))
    const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
    await stub.fetch('http://renderer/fail')
    const response = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(response.status).toBe(500)
    const [quota] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId))
    expect(quota?.bytesReserved).toBe(0)
    expect(quota?.bytesUsed).toBe(0)
  })
})
