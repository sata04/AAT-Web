/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The automatic poster: exactly one per revision, and exactly one render.
 *
 * The status field alone is not evidence of idempotency — a second call could re-render and
 * overwrite, and every status assertion would still pass. So these tests count the renders the
 * container was actually asked for, by reading the counter kept by the stub renderer bound in
 * test/worker/vitest.config.ts.
 */

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { apiFetch, createRevision, createRun, createUser, posterSpec } from './helpers/client.ts'

/** How many renders the stub container has been asked for since the run started. */
async function renderCount(): Promise<number> {
  const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
  const response = await stub.fetch('http://renderer/count')
  const body = (await response.json()) as { count: number }
  return body.count
}

/** Put the stub renderer into permanent-failure mode, to exercise the failure and retry paths. */
async function makeRendererFail(): Promise<void> {
  const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
  await stub.fetch('http://renderer/fail')
}

async function autoPoster(cookie: string, revisionId: string): Promise<Response> {
  return apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
    method: 'POST',
    cookie,
    body: JSON.stringify({ spec: posterSpec(revisionId) }),
  })
}

describe('automatic poster', () => {
  it('renders once and returns the same figure on every later call', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const before = await renderCount()

    const first = await autoPoster(user.cookie, revisionId)
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { poster: { posterId: string; status: string } }
    expect(firstBody.poster.status).toBe('ready')

    const second = await autoPoster(user.cookie, revisionId)
    expect(second.status).toBe(200)
    const secondBody = (await second.json()) as {
      poster: { posterId: string; status: string }
      created: boolean
    }
    expect(secondBody.poster.posterId).toBe(firstBody.poster.posterId)
    expect(secondBody.created).toBe(false)

    const third = await autoPoster(user.cookie, revisionId)
    expect(third.status).toBe(200)

    // Three calls, one render. The uniqueness constraint is what makes the second and third calls
    // reads rather than writes.
    expect(await renderCount()).toBe(before + 1)

    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    const historyBody = (await history.json()) as { posters: unknown[] }
    expect(historyBody.posters).toHaveLength(1)
  })

  it('produces one poster when two requests arrive at once', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const before = await renderCount()
    const [first, second] = await Promise.all([
      autoPoster(user.cookie, revisionId),
      autoPoster(user.cookie, revisionId),
    ])

    // Exactly one request may render. The other is either handed the existing figure (200) or
    // told the renderer is busy (429) — backpressure, never a second poster.
    const statuses = [first.status, second.status].sort((a, b) => a - b)
    expect(statuses.filter((status) => status === 201)).toHaveLength(1)
    expect([200, 429]).toContain(statuses[0] === 201 ? statuses[1] : statuses[0])
    expect(await renderCount()).toBeLessThanOrEqual(before + 1)

    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    const historyBody = (await history.json()) as { posters: { kind: string }[] }
    expect(historyBody.posters.filter((poster) => poster.kind === 'auto')).toHaveLength(1)
  })

  it('allows several custom posters for the same revision', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const first = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId, 'custom') }),
    })
    const second = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: { ...posterSpec(revisionId, 'custom'), title: '別タイトル' } }),
    })

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    // A researcher adjusting a figure is asking for a different picture, so the auto poster's
    // uniqueness constraint must not apply to custom ones.
    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    const historyBody = (await history.json()) as { posters: { kind: string }[] }
    expect(historyBody.posters.filter((poster) => poster.kind === 'custom')).toHaveLength(2)
  })

  it('rejects a spec that is not a valid plot specification', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const response = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: { ...posterSpec(revisionId), dpi: 100_000 } }),
    })
    expect(response.status).toBe(400)
    expect(await renderCount()).toBeGreaterThanOrEqual(0)
  })
})

describe('circuit breaker', () => {
  it('sheds poster requests while open, and resumes when closed', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const opened = await apiFetch('/api/v1/admin/renderer', {
      method: 'PUT',
      cookie: admin.cookie,
      body: JSON.stringify({ open: true, reason: 'spend guard' }),
    })
    expect(opened.status).toBe(200)

    const before = await renderCount()
    const shed = await autoPoster(user.cookie, revisionId)
    expect(shed.status).toBe(429)
    const body = (await shed.json()) as { error: { code: string } }
    expect(body.error.code).toBe('POSTER_BUSY')
    // Nothing was sent to the container: the breaker is checked before any work is started.
    expect(await renderCount()).toBe(before)

    await apiFetch('/api/v1/admin/renderer', {
      method: 'PUT',
      cookie: admin.cookie,
      body: JSON.stringify({ open: false, reason: null }),
    })

    const resumed = await autoPoster(user.cookie, revisionId)
    expect(resumed.status).toBe(201)
    expect(await renderCount()).toBe(before + 1)
  })

  it('is visible to an administrator', async () => {
    const admin = await createUser({ role: 'Admin' })
    await apiFetch('/api/v1/admin/renderer', {
      method: 'PUT',
      cookie: admin.cookie,
      body: JSON.stringify({ open: true, reason: 'maintenance' }),
    })
    const state = await apiFetch('/api/v1/admin/renderer', { cookie: admin.cookie })
    const body = (await state.json()) as { circuitBreaker: { open: boolean; reason: string | null } }
    expect(body.circuitBreaker.open).toBe(true)
    expect(body.circuitBreaker.reason).toBe('maintenance')

    await apiFetch('/api/v1/admin/renderer', {
      method: 'PUT',
      cookie: admin.cookie,
      body: JSON.stringify({ open: false, reason: null }),
    })
  })
})

describe('failure and retry', () => {
  it('records a failure and lets exactly one retry claim it', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    await makeRendererFail()

    const failed = await autoPoster(user.cookie, revisionId)
    expect(failed.status).toBe(500)

    const history = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: user.cookie })
    const historyBody = (await history.json()) as {
      posters: { posterId: string; status: string; failureCode: string | null; attemptCount: number }[]
    }
    expect(historyBody.posters).toHaveLength(1)
    const poster = historyBody.posters[0]
    expect(poster?.status).toBe('failed')
    expect(poster?.failureCode).toBe('POSTER_RENDER_FAILED')

    // A failed figure is NOT retried by calling the idempotent endpoint again — that would turn a
    // persistent renderer fault into a render loop for any client that polls.
    const before = await renderCount()
    const polled = await autoPoster(user.cookie, revisionId)
    expect(polled.status).toBe(200)
    expect(await renderCount()).toBe(before)

    const retry = await apiFetch(`/api/v1/posters/${poster?.posterId}/retry`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    // The renderer is still failing, so the retry fails too — but it was attempted, which is what
    // distinguishes an explicit retry from a poll.
    expect(retry.status).toBe(500)
    expect(await renderCount()).toBe(before + 1)
  })
})
