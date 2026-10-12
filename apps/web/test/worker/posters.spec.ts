/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Poster upload: the Worker records a PNG the browser already drew.
 *
 * There is no renderer to count calls against, so idempotency is asserted on what the upload
 * actually consumed: the `poster_figures` rows, the `cloud_objects` rows and the quota charge —
 * all of which must say exactly one poster happened, however many times the endpoint was asked.
 */

import { createExecutionContext, env } from 'cloudflare:test'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../../worker/config.ts'
import { cloudObjects, posterFigures, quotaUsage } from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import {
  apiFetch,
  createRevision,
  createRun,
  createUser,
  db,
  ORIGIN,
  POSTER_PNG_BASE64,
  POSTER_PNG_BYTES,
  posterSpec,
  type TestUser,
} from './helpers/client.ts'

async function autoPoster(
  cookie: string,
  revisionId: string,
  overrides: { spec?: unknown; pngBase64?: string; engineVersion?: string } = {},
): Promise<Response> {
  return apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      spec: overrides.spec ?? posterSpec(revisionId),
      pngBase64: overrides.pngBase64 ?? POSTER_PNG_BASE64,
      ...(overrides.engineVersion === undefined ? {} : { engineVersion: overrides.engineVersion }),
    }),
  })
}

/** The owner's storage accounting row — where a poster's bytes are actually charged. */
async function quotaFor(user: TestUser) {
  const [row] = await db().select().from(quotaUsage).where(eq(quotaUsage.userId, user.userId)).limit(1)
  return row
}

/** Poster objects under the owner's name — the upload, not the figure row. */
async function posterObjectsFor(user: TestUser) {
  return db()
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.ownerUserId, user.userId), eq(cloudObjects.kind, 'poster')))
}

describe('automatic poster', () => {
  it('stores the uploaded PNG once and returns the same figure on every later call', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const first = await autoPoster(user.cookie, revisionId, { engineVersion: 'pyodide-test/1.0' })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as {
      poster: { posterId: string; status: string; rendererVersion: string | null }
    }
    expect(firstBody.poster.status).toBe('ready')
    // The engine version is recorded as provenance — it is the client's own renderer now.
    expect(firstBody.poster.rendererVersion).toBe('pyodide-test/1.0')

    // The stored object is the PNG the client sent, served back as an image.
    const image = await apiFetch(`/api/v1/posters/${firstBody.poster.posterId}/image`, {
      cookie: user.cookie,
    })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([...POSTER_PNG_BYTES])

    const second = await autoPoster(user.cookie, revisionId)
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      poster: { posterId: string; status: string }
      created: boolean
    }
    expect(secondBody.poster.posterId).toBe(firstBody.poster.posterId)
    expect(secondBody.created).toBe(false)

    // Three assertions of "once": one figure, one object, one charge of exactly the PNG's size.
    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    expect(((await history.json()) as { posters: unknown[] }).posters).toHaveLength(1)

    const objects = await posterObjectsFor(user)
    expect(objects).toHaveLength(1)
    expect(objects[0]?.byteSize).toBe(POSTER_PNG_BYTES.length)

    const quota = await quotaFor(user)
    expect(quota?.bytesUsed).toBe(POSTER_PNG_BYTES.length)
    expect(quota?.bytesReserved).toBe(0)
    expect(quota?.objectCount).toBe(1)
  })

  it('produces one poster — and one charge — when two requests arrive at once', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const [first, second] = await Promise.all([
      autoPoster(user.cookie, revisionId),
      autoPoster(user.cookie, revisionId),
    ])
    // Exactly one request records the figure; the other is handed it back.
    expect([first.status, second.status].sort()).toEqual([200, 201])

    const figures = await db()
      .select()
      .from(posterFigures)
      .where(and(eq(posterFigures.analysisRevisionId, revisionId), eq(posterFigures.kind, 'auto')))
    expect(figures).toHaveLength(1)

    // The losing upload stored its own object under its own key and then unwound it: the loser
    // may cost a moment's write, but it must not cost quota or leave an object behind.
    const quota = await quotaFor(user)
    expect(quota?.bytesUsed).toBe(POSTER_PNG_BYTES.length)
    expect(quota?.objectCount).toBe(1)
    const objects = await posterObjectsFor(user)
    expect(objects).toHaveLength(1)
  })

  it('allows several custom posters for the same revision', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const first = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId, 'custom'), pngBase64: POSTER_PNG_BASE64 }),
    })
    const second = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({
        spec: { ...posterSpec(revisionId, 'custom'), title: '別タイトル' },
        pngBase64: POSTER_PNG_BASE64,
      }),
    })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    // A researcher adjusting a figure is asking for a different picture, so the auto poster's
    // uniqueness constraint must not apply to custom ones.
    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    const historyBody = (await history.json()) as { posters: { kind: string; status: string }[] }
    expect(historyBody.posters.filter((poster) => poster.kind === 'custom')).toHaveLength(2)
    expect(historyBody.posters.every((poster) => poster.status === 'ready')).toBe(true)
  })

  it('rejects a spec that is not a valid plot specification', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const response = await autoPoster(user.cookie, revisionId, {
      spec: { ...posterSpec(revisionId), dpi: 100_000 },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_ANALYSIS_CONFIG',
    )
  })

  it.each([
    // Not decodable at all.
    { name: 'not strict base64', pngBase64: '!!!not-base64!!!', reason: 'invalid_png_base64' },
    // Decodes fine — it just isn't the image the field claims.
    { name: 'base64 but not a PNG', pngBase64: btoa('this is not a png'), reason: 'png_signature_mismatch' },
  ])('rejects a PNG body that is $name', async ({ pngBase64, reason }) => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const response = await autoPoster(user.cookie, revisionId, { pngBase64 })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; details?: { reason?: string } } }
    expect(body.error.code).toBe('INVALID_ANALYSIS_CONFIG')
    expect(body.error.details?.reason).toBe(reason)
  })

  it('rejects a PNG larger than the configured maximum', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // Signature-valid, oversized: the size check is what must fire.
    const oversized = new Uint8Array(70_000)
    oversized.set(POSTER_PNG_BYTES)
    let binary = ''
    for (const byte of oversized) binary += String.fromCharCode(byte)

    const response = await autoPoster(user.cookie, revisionId, { pngBase64: btoa(binary) })
    expect(response.status).toBe(413)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('REQUEST_TOO_LARGE')
  })

  it('refuses the upload — storing nothing — when the owner is out of quota', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    // One byte short of the PNG, so the reservation itself is the failure. The row already
    // exists — the snapshot upload created it — so it is shrunk, not inserted.
    await db()
      .update(quotaUsage)
      .set({ bytesLimit: POSTER_PNG_BYTES.length - 1 })
      .where(eq(quotaUsage.userId, user.userId))

    const before = await quotaFor(user)
    const response = await autoPoster(user.cookie, revisionId)
    expect(response.status).toBe(429)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('QUOTA_EXCEEDED')

    // Nothing was stored: no figure, no poster object, and the charge never happened.
    expect(await posterObjectsFor(user)).toHaveLength(0)
    expect(
      await db().select().from(posterFigures).where(eq(posterFigures.analysisRevisionId, revisionId)),
    ).toHaveLength(0)
    const quota = await quotaFor(user)
    expect(quota?.bytesUsed).toBe(before?.bytesUsed)
    expect(quota?.bytesReserved).toBe(before?.bytesReserved)
  })
})

describe('cloud disabled', () => {
  /**
   * `AAT_CLOUD_ENABLED: 'false'` deploys the SPA alone. The Worker may not even exist — but when
   * it is deployed with the flag, it must answer every request 404 without a single secret or
   * binding needing to exist.
   */
  it('answers 404 RESOURCE_NOT_FOUND on /api/*, with a bare env', async () => {
    const bareEnv = { AAT_CLOUD_ENABLED: 'false' } as unknown as Env
    for (const path of ['/api/v1/me', '/api/auth/passkey/generate-authenticate-options']) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`), bareEnv, createExecutionContext())
      expect(response.status, path).toBe(404)
      const body = (await response.json()) as { error: { code: string } }
      expect(body.error.code, path).toBe('RESOURCE_NOT_FOUND')
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
  })

  it('answers 404 even when the flag rides on a fully-bound env', async () => {
    const disabledEnv = { ...env, AAT_CLOUD_ENABLED: 'false' } as unknown as Env
    const response = await worker.fetch(
      new Request(`${ORIGIN}/api/v1/runs`),
      disabledEnv,
      createExecutionContext(),
    )
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('RESOURCE_NOT_FOUND')
  })

  it('resolves config without a single secret when disabled', () => {
    // The whole point of the flag: a deployment that serves only the SPA has no auth secrets to
    // set, so resolveConfig must not require them.
    const config = resolveConfig({ AAT_CLOUD_ENABLED: 'false' } as unknown as Env)
    expect(config.cloudEnabled).toBe(false)
  })
})
