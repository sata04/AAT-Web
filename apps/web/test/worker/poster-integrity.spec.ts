import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { cloudObjects, posterFigures, quotaReservations } from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import { getQuotaState, sweepStaleReservations } from '../../worker/services/quota.ts'
import { apiFetch, createRevision, createRun, createUser, db, ORIGIN, posterSpec } from './helpers/client.ts'
import { interceptD1 } from './helpers/intercept-d1.ts'

describe('poster object recovery', () => {
  it('deletes a late poster PUT even after the sweeper removed its object row', async () => {
    const user = await createUser()
    const revisionId = await createRevision(user, await createRun(user))
    let entered = () => {}
    let resume = () => {}
    const arrived = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const bindings = {
      ...env,
      AAT_OBJECTS: new Proxy(env.AAT_OBJECTS, {
        get(target, property) {
          if (property === 'put')
            return async (...args: Parameters<R2Bucket['put']>) => {
              entered()
              await gate
              return target.put(...args)
            }
          const value: unknown = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    }
    const upload = worker.fetch(
      new Request(`${ORIGIN}/api/v1/revisions/${revisionId}/poster/auto`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ spec: posterSpec(revisionId) }),
      }),
      bindings,
      createExecutionContext(),
    )
    await arrived
    const [object] = await db().select().from(cloudObjects).where(eq(cloudObjects.ownerUserId, user.userId))
    if (!object) throw new Error('missing staged poster')
    try {
      await db()
        .update(quotaReservations)
        .set({ expiresAt: new Date(0) })
        .where(eq(quotaReservations.userId, user.userId))
      await sweepStaleReservations(db(), env.AAT_OBJECTS, new Date(), 10000)
      expect(await db().select().from(cloudObjects).where(eq(cloudObjects.id, object.id))).toHaveLength(0)
    } finally {
      resume()
    }
    expect((await upload).status).toBe(500)
    expect(await env.AAT_OBJECTS.head(object.r2Key)).toBeNull()
    expect(await getQuotaState(db(), user.userId)).toMatchObject({
      bytesUsed: 0,
      bytesReserved: 0,
      objectCount: 0,
    })
  })

  it('cannot publish bytes reclaimed after finalisation, and preserves a live poster after expiry', async () => {
    const user = await createUser()
    const revisionId = await createRevision(user, await createRun(user))
    let swept = false
    const bindings = {
      ...env,
      DB: interceptD1(env.DB, async (sql, phase) => {
        if (
          !swept &&
          phase === 'before' &&
          sql.startsWith('update "poster_figures" set') &&
          sql.includes('"object_id"')
        ) {
          swept = true
          await db()
            .update(quotaReservations)
            .set({ expiresAt: new Date(0) })
            .where(eq(quotaReservations.userId, user.userId))
          await sweepStaleReservations(db(), env.AAT_OBJECTS, new Date(), 10000)
        }
      }),
    }
    const request = {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    }
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/revisions/${revisionId}/poster/auto`, request),
      bindings,
      createExecutionContext(),
    )
    expect(response.status).toBe(200)
    expect(swept).toBe(true)
    const [figure] = await db()
      .select()
      .from(posterFigures)
      .where(eq(posterFigures.analysisRevisionId, revisionId))
    expect(figure?.objectId).toBeNull()
    expect(figure?.status).not.toBe('ready')
    // Make the interrupted render eligible for takeover.
    await db()
      .update(posterFigures)
      .set({ startedAt: new Date(0) })
      .where(eq(posterFigures.id, figure?.id ?? ''))
    expect(
      (await apiFetch(`/api/v1/posters/${figure?.id}/retry`, { ...request, cookie: user.cookie })).status,
    ).toBe(201)
    await db()
      .update(quotaReservations)
      .set({ expiresAt: new Date(0) })
      .where(eq(quotaReservations.userId, user.userId))
    await sweepStaleReservations(db(), env.AAT_OBJECTS, new Date(), 10000)
    expect((await apiFetch(`/api/v1/posters/${figure?.id}/image`, { cookie: user.cookie })).status).toBe(200)
    expect(await getQuotaState(db(), user.userId)).toMatchObject({ bytesReserved: 0, objectCount: 1 })
  })
})
