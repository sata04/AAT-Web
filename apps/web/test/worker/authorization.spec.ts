/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Authorization: authentication, capabilities, and ownership.
 *
 * Three separate questions, tested separately, because passing one is not passing another:
 *
 *  1. An anonymous caller gets nothing.
 *  2. A signed-in caller without the capability gets nothing (a Viewer cannot write).
 *  3. A signed-in caller WITH the capability still gets nothing that belongs to someone else.
 *
 * (3) is the IDOR suite, and it is the one that a capability check alone would pass while leaking
 * every user's data to every other user.
 */

import { describe, expect, it } from 'vitest'
import { apiFetch, createRevision, createRun, createUser, posterSpec } from './helpers/client.ts'

interface ProtectedEndpoint {
  method: string
  path: string
  body?: unknown
}

const PROTECTED_ENDPOINTS: ProtectedEndpoint[] = [
  { method: 'GET', path: '/api/v1/me' },
  { method: 'GET', path: '/api/v1/me/passkeys' },
  { method: 'GET', path: '/api/v1/runs' },
  { method: 'POST', path: '/api/v1/runs', body: { originalFilename: '260811a_data.csv' } },
  { method: 'GET', path: '/api/v1/runs/01ANYTHING' },
  { method: 'PATCH', path: '/api/v1/runs/01ANYTHING', body: { memo: 'x' } },
  { method: 'DELETE', path: '/api/v1/runs/01ANYTHING' },
  { method: 'GET', path: '/api/v1/projects' },
  { method: 'POST', path: '/api/v1/projects', body: { name: 'p' } },
  { method: 'GET', path: '/api/v1/runs/01ANYTHING/revisions' },
  { method: 'POST', path: '/api/v1/runs/01ANYTHING/revisions', body: {} },
  { method: 'GET', path: '/api/v1/revisions/01ANYTHING' },
  { method: 'GET', path: '/api/v1/revisions/01ANYTHING/snapshot' },
  { method: 'GET', path: '/api/v1/runs/01ANYTHING/source' },
  { method: 'DELETE', path: '/api/v1/runs/01ANYTHING/source' },
  { method: 'POST', path: '/api/v1/revisions/01ANYTHING/poster/auto', body: { spec: {} } },
  { method: 'POST', path: '/api/v1/revisions/01ANYTHING/posters', body: { spec: {} } },
  { method: 'GET', path: '/api/v1/revisions/01ANYTHING/posters' },
  { method: 'GET', path: '/api/v1/posters/01ANYTHING/image' },
  { method: 'GET', path: '/api/v1/admin/users' },
  { method: 'PATCH', path: '/api/v1/admin/users/01ANYTHING', body: { role: 'Viewer' } },
  { method: 'DELETE', path: '/api/v1/admin/users/01ANYTHING' },
  { method: 'GET', path: '/api/v1/admin/invitations' },
  {
    method: 'POST',
    path: '/api/v1/admin/invitations',
    body: { kind: 'registration', role: 'Viewer', displayName: 'x', ttlHours: 1 },
  },
  { method: 'GET', path: '/api/v1/admin/storage' },
  { method: 'GET', path: '/api/v1/admin/renderer' },
  { method: 'PUT', path: '/api/v1/admin/renderer', body: { open: true } },
  { method: 'GET', path: '/api/v1/admin/audit' },
  { method: 'PUT', path: '/api/v1/admin/quotas/01ANYTHING', body: { bytesLimit: 1 } },
]

describe('anonymous access', () => {
  it.each(PROTECTED_ENDPOINTS)('rejects $method $path', async (endpoint) => {
    const response = await apiFetch(endpoint.path, {
      method: endpoint.method,
      ...(endpoint.body === undefined ? {} : { body: JSON.stringify(endpoint.body) }),
    })
    expect(response.status).toBe(401)
    const body = (await response.json()) as { error: { code: string } }
    expect(body.error.code).toBe('AUTH_REQUIRED')
  })
})

describe('capabilities', () => {
  it('lets a Researcher create runs but a Viewer only read them', async () => {
    const researcher = await createUser({ role: 'Researcher' })
    const viewer = await createUser({ role: 'Viewer' })

    const created = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: researcher.cookie,
      body: JSON.stringify({ originalFilename: '260811a_data.csv' }),
    })
    expect(created.status).toBe(201)

    const viewerList = await apiFetch('/api/v1/runs', { cookie: viewer.cookie })
    expect(viewerList.status).toBe(200)

    const viewerCreate = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: viewer.cookie,
      body: JSON.stringify({ originalFilename: '260812a_data.csv' }),
    })
    expect(viewerCreate.status).toBe(403)
    const body = (await viewerCreate.json()) as { error: { code: string; details?: { required?: string } } }
    expect(body.error.code).toBe('FORBIDDEN')
    // The response names the capability that was missing, not the role that was expected.
    expect(body.error.details?.required).toBe('analysis:create')
  })

  it('refuses administration to a Researcher and allows it to an Admin', async () => {
    const researcher = await createUser({ role: 'Researcher' })
    const admin = await createUser({ role: 'Admin' })

    expect((await apiFetch('/api/v1/admin/users', { cookie: researcher.cookie })).status).toBe(403)
    expect((await apiFetch('/api/v1/admin/audit', { cookie: researcher.cookie })).status).toBe(403)
    expect((await apiFetch('/api/v1/admin/users', { cookie: admin.cookie })).status).toBe(200)
    expect((await apiFetch('/api/v1/admin/audit', { cookie: admin.cookie })).status).toBe(200)
  })

  it('refuses poster generation to a Viewer', async () => {
    const researcher = await createUser({ role: 'Researcher' })
    const viewer = await createUser({ role: 'Viewer' })
    const runId = await createRun(researcher)
    const revisionId = await createRevision(researcher, runId)

    const response = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: viewer.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(response.status).toBe(403)
  })

  it('reports the capability set the role actually has', async () => {
    const viewer = await createUser({ role: 'Viewer' })
    const me = await apiFetch('/api/v1/me', { cookie: viewer.cookie })
    const body = (await me.json()) as { capabilities: string[] }
    expect(body.capabilities).toEqual(['analysis:read', 'cloud:read'])
  })
})

describe('IDOR', () => {
  it("hides another user's run from reads, writes and deletes", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)

    const read = await apiFetch(`/api/v1/runs/${runId}`, { cookie: stranger.cookie })
    // 404, not 403: "this exists but is not yours" is an existence oracle.
    expect(read.status).toBe(404)

    const write = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: stranger.cookie,
      body: JSON.stringify({ memo: 'mine now' }),
    })
    expect(write.status).toBe(404)

    const destroy = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'DELETE',
      cookie: stranger.cookie,
    })
    expect(destroy.status).toBe(404)

    // ...and the run is untouched.
    const stillThere = await apiFetch(`/api/v1/runs/${runId}`, { cookie: owner.cookie })
    expect(stillThere.status).toBe(200)
    const body = (await stillThere.json()) as { run: { memo: string | null } }
    expect(body.run.memo).toBeNull()
  })

  it("keeps another user's run out of the gallery listing", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    await createRun(owner)

    const list = await apiFetch('/api/v1/runs', { cookie: stranger.cookie })
    const body = (await list.json()) as { runs: unknown[] }
    expect(body.runs).toHaveLength(0)
  })

  it("hides another user's revision and its snapshot", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    expect((await apiFetch(`/api/v1/revisions/${revisionId}`, { cookie: stranger.cookie })).status).toBe(404)
    expect(
      (await apiFetch(`/api/v1/revisions/${revisionId}/snapshot`, { cookie: stranger.cookie })).status,
    ).toBe(404)
    expect((await apiFetch(`/api/v1/runs/${runId}/revisions`, { cookie: stranger.cookie })).status).toBe(404)
  })

  it("refuses to add a revision to another user's run", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)

    const response = await apiFetch(`/api/v1/runs/${runId}/revisions`, {
      method: 'POST',
      cookie: stranger.cookie,
      body: JSON.stringify({
        sourceSha256: 'c'.repeat(64),
        configHash: 'd'.repeat(64),
        config: {},
        engineVersion: '1.0.0',
        snapshotFormatVersion: 1,
        metrics: {
          windowSize: 0.1,
          inner: { mean: 0, std: 0, startTime: 0 },
          drag: { mean: null, std: null, startTime: null },
          innerSampleCount: 1,
          dragSampleCount: 0,
          warningCount: 0,
        },
      }),
    })
    expect(response.status).toBe(404)
  })

  it("refuses to generate a poster from another user's revision", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    const auto = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: stranger.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(auto.status).toBe(404)

    const custom = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: stranger.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId, 'custom') }),
    })
    expect(custom.status).toBe(404)
  })

  it("refuses to download another user's poster image", async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    const rendered = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: owner.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(rendered.status).toBe(201)
    const poster = (await rendered.json()) as { poster: { posterId: string; status: string } }
    expect(poster.poster.status).toBe('ready')

    const theirs = await apiFetch(`/api/v1/posters/${poster.poster.posterId}/image`, {
      cookie: owner.cookie,
    })
    expect(theirs.status).toBe(200)
    expect(theirs.headers.get('content-type')).toBe('image/png')

    const stolen = await apiFetch(`/api/v1/posters/${poster.poster.posterId}/image`, {
      cookie: stranger.cookie,
    })
    expect(stolen.status).toBe(404)
  })

  it('rejects a plot spec that names a different revision than the URL', async () => {
    const owner = await createUser()
    const runA = await createRun(owner, '260811a_data.csv')
    const runB = await createRun(owner, '260811b_data.csv')
    const revisionA = await createRevision(owner, runA)
    const revisionB = await createRevision(owner, runB, { sourceSha256: 'e'.repeat(64) })

    const response = await apiFetch(`/api/v1/revisions/${revisionA}/poster/auto`, {
      method: 'POST',
      cookie: owner.cookie,
      // The spec claims to be a figure of revision B while being filed under revision A.
      body: JSON.stringify({ spec: posterSpec(revisionB) }),
    })
    expect(response.status).toBe(400)
  })
})
