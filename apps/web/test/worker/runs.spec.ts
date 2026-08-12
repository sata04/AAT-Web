/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Runs, revisions, and the original-CSV backup.
 *
 * The two properties worth testing here are domain rules rather than plumbing:
 *
 *  - a revision is immutable, and "the same analysis" is one revision however many times it is
 *    submitted;
 *  - the original CSV is never uploaded because the user happens to be signed in.
 */

import { sha256Hex } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import { apiFetch, createRevision, createRun, createUser } from './helpers/client.ts'

const CSV = '時間,内カプセル,ドラッグシールド\n0.000,9.8,9.8\n0.001,9.7,9.8\n'

describe('runs', () => {
  it('derives the run code and experiment date from the filename', async () => {
    const user = await createUser()
    const response = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ originalFilename: '260811a_data.csv' }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { run: { runCode: string; experimentDate: string } }
    // The suffix is part of the identity: 260811a and 260811b are two experiments, not two copies.
    expect(body.run.runCode).toBe('260811a')
    expect(body.run.experimentDate).toBe('2026-08-11')
  })

  it('refuses a second run with the same code for the same owner, and allows it for another', async () => {
    const first = await createUser()
    const second = await createUser()

    await createRun(first, '260811a_data.csv')
    const duplicate = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: first.cookie,
      body: JSON.stringify({ originalFilename: '260811a_data.csv' }),
    })
    expect(duplicate.status).toBe(400)

    // Two researchers each having a run 260811a is normal.
    const other = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: second.cookie,
      body: JSON.stringify({ originalFilename: '260811a_data.csv' }),
    })
    expect(other.status).toBe(201)
  })

  it('updates the memo and replaces the tag set', async () => {
    const user = await createUser()
    const runId = await createRun(user)

    const patched = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: JSON.stringify({ memo: '真空度が低かった', tags: ['再測定', '真空'] }),
    })
    expect(patched.status).toBe(200)

    const detail = await apiFetch(`/api/v1/runs/${runId}`, { cookie: user.cookie })
    const body = (await detail.json()) as { run: { memo: string; tags: string[] } }
    expect(body.run.memo).toBe('真空度が低かった')
    expect(body.run.tags.sort()).toEqual(['再測定', '真空'])

    await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: user.cookie,
      body: JSON.stringify({ tags: ['真空'] }),
    })
    const after = await apiFetch(`/api/v1/runs/${runId}`, { cookie: user.cookie })
    const afterBody = (await after.json()) as { run: { tags: string[] } }
    expect(afterBody.run.tags).toEqual(['真空'])
  })

  it('searches, filters by tag and paginates', async () => {
    const user = await createUser()
    for (const suffix of ['a', 'b', 'c']) {
      const runId = await createRun(user, `2608${suffix === 'a' ? '11' : '12'}${suffix}_data.csv`)
      if (suffix === 'b') {
        await apiFetch(`/api/v1/runs/${runId}`, {
          method: 'PATCH',
          cookie: user.cookie,
          body: JSON.stringify({ tags: ['注目'] }),
        })
      }
    }

    const searched = await apiFetch('/api/v1/runs?search=260812', { cookie: user.cookie })
    const searchedBody = (await searched.json()) as { runs: { runCode: string }[] }
    expect(searchedBody.runs.map((run) => run.runCode).sort()).toEqual(['260812b', '260812c'])

    const tagged = await apiFetch('/api/v1/runs?tag=注目', { cookie: user.cookie })
    const taggedBody = (await tagged.json()) as { runs: { runCode: string }[] }
    expect(taggedBody.runs.map((run) => run.runCode)).toEqual(['260812b'])

    const firstPage = await apiFetch('/api/v1/runs?limit=2', { cookie: user.cookie })
    const firstBody = (await firstPage.json()) as { runs: unknown[]; nextCursor: string | null }
    expect(firstBody.runs).toHaveLength(2)
    expect(firstBody.nextCursor).not.toBeNull()

    const secondPage = await apiFetch(`/api/v1/runs?limit=2&cursor=${firstBody.nextCursor}`, {
      cookie: user.cookie,
    })
    const secondBody = (await secondPage.json()) as { runs: unknown[]; nextCursor: string | null }
    expect(secondBody.runs).toHaveLength(1)
    expect(secondBody.nextCursor).toBeNull()
  })
})

describe('analysis revisions', () => {
  it('treats the same source, config and engine as one revision however often it is submitted', async () => {
    const user = await createUser()
    const runId = await createRun(user)

    const first = await createRevision(user, runId)
    const second = await createRevision(user, runId)
    // Not a second revision: re-analysing identical bytes with identical settings is the same
    // analysis, and a retried request must not fork the history.
    expect(second).toBe(first)

    const list = await apiFetch(`/api/v1/runs/${runId}/revisions`, { cookie: user.cookie })
    const body = (await list.json()) as { revisions: unknown[] }
    expect(body.revisions).toHaveLength(1)
  })

  it('records a different configuration as a new revision, numbered in order', async () => {
    const user = await createUser()
    const runId = await createRun(user)

    await createRevision(user, runId, { configHash: 'b'.repeat(64) })
    await createRevision(user, runId, { configHash: 'c'.repeat(64) })

    const list = await apiFetch(`/api/v1/runs/${runId}/revisions`, { cookie: user.cookie })
    const body = (await list.json()) as { revisions: { revisionNumber: number }[] }
    expect(body.revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2])
  })

  it('exposes no route that mutates a revision', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const response = await apiFetch(`/api/v1/revisions/${revisionId}`, {
        method,
        cookie: user.cookie,
        body: JSON.stringify({ notes: 'rewritten' }),
      })
      expect(response.status).toBe(404)
    }
  })

  it('returns the metrics it was given, tags and all', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)

    const detail = await apiFetch(`/api/v1/revisions/${revisionId}`, { cookie: user.cookie })
    const body = (await detail.json()) as {
      metrics: { inner: { mean: number }; drag: { mean: string } }
    }
    expect(body.metrics.inner.mean).toBe(0.0001)
    // NaN survives the round trip as its tag rather than collapsing to null.
    expect(body.metrics.drag.mean).toBe('NaN')
  })
})

describe('original CSV backup', () => {
  async function upload(cookie: string, runId: string, withIntent: boolean): Promise<Response> {
    const bytes = new TextEncoder().encode(CSV)
    const query = new URLSearchParams({
      declaredBytes: String(bytes.length),
      sha256: await sha256Hex(bytes),
      filename: '260811a_data.csv',
    })
    return apiFetch(`/api/v1/runs/${runId}/source?${query}`, {
      method: 'PUT',
      cookie,
      headers: withIntent
        ? { 'content-type': 'text/csv', 'x-aat-source-backup': 'requested-by-user' }
        : { 'content-type': 'text/csv' },
      body: bytes as BodyInit,
    })
  }

  it('is off unless the request explicitly asks for it', async () => {
    const user = await createUser()
    const runId = await createRun(user)

    const implicit = await upload(user.cookie, runId, false)
    // Being signed in is not consent to upload raw measurement data.
    expect(implicit.status).toBe(403)
    const body = (await implicit.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe('source_backup_not_requested')

    const explicit = await upload(user.cookie, runId, true)
    expect(explicit.status).toBe(201)
  })

  it('stores the filename as metadata and never in the object key', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    expect((await upload(user.cookie, runId, true)).status).toBe(201)

    const download = await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: user.cookie })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe(CSV)
    // The name comes back in the Content-Disposition header, RFC 5987 encoded...
    expect(download.headers.get('content-disposition')).toContain('260811a_data.csv')

    const { db } = await import('./helpers/client.ts')
    const { cloudObjects } = await import('../../worker/db/schema.ts')
    const { eq } = await import('drizzle-orm')
    const [object] = await db().select().from(cloudObjects).where(eq(cloudObjects.runId, runId)).limit(1)
    // ...and nowhere near the R2 key, which is built only from identifiers this server generated.
    expect(object?.r2Key).not.toContain('260811a_data.csv')
    expect(object?.originalFilename).toBe('260811a_data.csv')
  })

  it('is deletable, and deleting it gives the space back', async () => {
    const user = await createUser()
    const runId = await createRun(user)
    await upload(user.cookie, runId, true)

    const before = (await (await apiFetch('/api/v1/me', { cookie: user.cookie })).json()) as {
      quota: { bytesUsed: number }
    }
    expect(before.quota.bytesUsed).toBeGreaterThan(0)

    const deleted = await apiFetch(`/api/v1/runs/${runId}/source`, {
      method: 'DELETE',
      cookie: user.cookie,
    })
    expect(deleted.status).toBe(200)

    const after = (await (await apiFetch('/api/v1/me', { cookie: user.cookie })).json()) as {
      quota: { bytesUsed: number }
    }
    expect(after.quota.bytesUsed).toBe(0)
  })

  it('is not downloadable by another user', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)
    await upload(owner.cookie, runId, true)

    const response = await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: stranger.cookie })
    expect(response.status).toBe(404)
  })

  it('refuses a Viewer, who has no raw:upload capability', async () => {
    const researcher = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    const runId = await createRun(researcher)

    const response = await upload(viewer.cookie, runId, true)
    expect(response.status).toBe(403)
  })
})
