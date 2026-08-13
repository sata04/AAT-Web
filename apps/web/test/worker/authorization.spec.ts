/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Authorization: authentication, capabilities, and reach.
 *
 * Three separate questions, tested separately, because passing one is not passing another:
 *
 *  1. An anonymous caller gets nothing.
 *  2. A signed-in caller without the capability gets nothing (a Viewer cannot write).
 *  3. A signed-in caller WITH the capability reaches exactly as far into another member's work as
 *     the policy says, and no further.
 *
 * (3) used to be the IDOR suite and asserted that every cross-user request answered 404. On
 * 2026-08-13 the repository owner decided this deployment is one research team's shared workspace:
 * everyone who can register is a member of the owner's group, so a signed-in researcher should be
 * able to see and reuse anyone's analysis. These tests now state that policy cell by cell rather
 * than asserting a blanket refusal.
 *
 * The table under test, which is also the table in worker/middleware/authorize.ts:
 *
 * | Action                                       | Owner | Researcher | Admin | Viewer |
 * | -------------------------------------------- | ----- | ---------- | ----- | ------ |
 * | Read runs, revisions, metrics, posters        | yes   | yes        | yes   | no     |
 * | Read/download snapshots and original CSVs     | yes   | yes        | yes   | no     |
 * | Generate a poster from a revision             | yes   | yes        | yes   | no     |
 * | Edit memo and tags                            | yes   | yes        | yes   | no     |
 * | Delete a run, upload/delete an original CSV   | yes   | no         | yes   | no     |
 * | Create a revision, upload a snapshot          | yes   | no         | no    | no     |
 *
 * Every refusal is asserted as **404, never 403**. That distinction carries more weight under this
 * policy, not less: a Viewer is the one role still confined to their own runs, and a 403 would tell
 * them exactly which run ids the rest of the team holds.
 */

import { sha256Hex } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import {
  apiFetch,
  createRevision,
  createRun,
  createUser,
  posterSpec,
  type TestUser,
} from './helpers/client.ts'
import { buildSnapshot, encodeForUpload } from './helpers/snapshot.ts'

interface ProtectedEndpoint {
  method: string
  path: string
  body?: unknown
}

const PROTECTED_ENDPOINTS: ProtectedEndpoint[] = [
  { method: 'GET', path: '/api/v1/me' },
  { method: 'GET', path: '/api/v1/me/passkeys' },
  { method: 'GET', path: '/api/v1/runs' },
  { method: 'GET', path: '/api/v1/workspace/runs' },
  { method: 'POST', path: '/api/v1/runs', body: { originalFilename: '260811a_data.csv' } },
  { method: 'GET', path: '/api/v1/runs/01ANYTHING' },
  { method: 'PATCH', path: '/api/v1/runs/01ANYTHING', body: { memo: 'x' } },
  { method: 'DELETE', path: '/api/v1/runs/01ANYTHING' },
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

const CSV = '時間,内カプセル,ドラッグシールド\n0.000,9.8,9.8\n0.001,9.7,9.8\n'
const SOURCE_SHA = 'a'.repeat(64)
const CONFIG_HASH = 'b'.repeat(64)

/** Upload the original CSV backup of `runId`, with the explicit-intent header. */
async function uploadSource(user: TestUser, runId: string): Promise<Response> {
  const bytes = new TextEncoder().encode(CSV)
  const query = new URLSearchParams({
    declaredBytes: String(bytes.length),
    sha256: await sha256Hex(bytes),
    filename: '260811a_data.csv',
  })
  return apiFetch(`/api/v1/runs/${runId}/source?${query}`, {
    method: 'PUT',
    cookie: user.cookie,
    headers: { 'content-type': 'text/csv', 'x-aat-source-backup': 'requested-by-user' },
    body: bytes as BodyInit,
  })
}

/** Attach the snapshot of `revisionId`, so the download door has something behind it. */
async function uploadSnapshot(user: TestUser, revisionId: string): Promise<Response> {
  const encoded = await encodeForUpload(buildSnapshot({ sourceSha256: SOURCE_SHA, configHash: CONFIG_HASH }))
  const query = new URLSearchParams({
    declaredBytes: String(encoded.bytes.length),
    sha256: encoded.sha256,
    format: 'json',
  })
  return apiFetch(`/api/v1/revisions/${revisionId}/snapshot?${query}`, {
    method: 'PUT',
    cookie: user.cookie,
    headers: { 'content-type': 'application/json' },
    body: encoded.bytes as BodyInit,
  })
}

/**
 * A researcher's run with everything hanging off it: a revision, its snapshot, a poster and an
 * original-CSV backup. Every door a colleague might come through has something behind it, so a
 * 404 in the tests below is a refusal rather than an absence.
 */
async function populatedRun(owner: TestUser, filename = '260811a_data.csv') {
  const runId = await createRun(owner, filename)
  const revisionId = await createRevision(owner, runId)
  expect((await uploadSnapshot(owner, revisionId)).status).toBe(201)
  expect((await uploadSource(owner, runId)).status).toBe(201)

  const rendered = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
    method: 'POST',
    cookie: owner.cookie,
    body: JSON.stringify({ spec: posterSpec(revisionId) }),
  })
  expect(rendered.status).toBe(201)
  const poster = (await rendered.json()) as { poster: { posterId: string } }

  return { runId, revisionId, posterId: poster.poster.posterId }
}

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
    // Unchanged by the workspace policy, and the reason a Viewer's reach did not widen: no
    // workspace:* capability, so every resolver refuses them anything they do not own.
    expect(body.capabilities).toEqual(['analysis:read', 'cloud:read'])
  })

  it('grants the workspace capabilities by role, not by handler', async () => {
    const researcher = await createUser({ role: 'Researcher' })
    const admin = await createUser({ role: 'Admin' })

    const researcherBody = (await (await apiFetch('/api/v1/me', { cookie: researcher.cookie })).json()) as {
      capabilities: string[]
    }
    expect(researcherBody.capabilities).toContain('workspace:read')
    expect(researcherBody.capabilities).toContain('workspace:annotate')
    // Destroying a colleague's experiment is not a peer action.
    expect(researcherBody.capabilities).not.toContain('workspace:destroy')

    const adminBody = (await (await apiFetch('/api/v1/me', { cookie: admin.cookie })).json()) as {
      capabilities: string[]
    }
    expect(adminBody.capabilities).toContain('workspace:destroy')
  })
})

/* ------------------------------------------------------------------------------------------- */
/* What a Researcher reaches in a colleague's work                                               */
/* ------------------------------------------------------------------------------------------- */

describe('a Researcher reads and reuses a colleague’s work', () => {
  it('reads the run, its revisions, its metrics and its posters', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId, revisionId } = await populatedRun(owner)

    const run = await apiFetch(`/api/v1/runs/${runId}`, { cookie: colleague.cookie })
    expect(run.status).toBe(200)
    const runBody = (await run.json()) as { run: { ownerUserId: string; runCode: string } }
    expect(runBody.run.runCode).toBe('260811a')
    // The response says whose it is, so a client can tell a colleague's measurement from its own.
    expect(runBody.run.ownerUserId).toBe(owner.userId)

    const revisions = await apiFetch(`/api/v1/runs/${runId}/revisions`, { cookie: colleague.cookie })
    expect(revisions.status).toBe(200)
    expect(((await revisions.json()) as { revisions: unknown[] }).revisions).toHaveLength(1)

    const revision = await apiFetch(`/api/v1/revisions/${revisionId}`, { cookie: colleague.cookie })
    expect(revision.status).toBe(200)
    const revisionBody = (await revision.json()) as { metrics: { inner: { mean: number } } }
    expect(revisionBody.metrics.inner.mean).toBe(0.0001)

    const posters = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: colleague.cookie })
    expect(posters.status).toBe(200)
    expect(((await posters.json()) as { posters: unknown[] }).posters).toHaveLength(1)
  })

  it('downloads the snapshot — the whole point of a shared workspace', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { revisionId } = await populatedRun(owner)

    // Replay, range statistics, Excel and custom posters are all rebuilt from these bytes.
    const download = await apiFetch(`/api/v1/revisions/${revisionId}/snapshot`, { cookie: colleague.cookie })
    expect(download.status).toBe(200)
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('downloads the original CSV backup', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId } = await populatedRun(owner)

    const download = await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: colleague.cookie })
    expect(download.status).toBe(200)
    expect(await download.text()).toBe(CSV)
  })

  it('downloads the poster image', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { posterId } = await populatedRun(owner)

    const image = await apiFetch(`/api/v1/posters/${posterId}/image`, { cookie: colleague.cookie })
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/png')
  })

  it('generates a custom poster from the colleague’s revision', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { revisionId } = await populatedRun(owner)

    const custom = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, {
      method: 'POST',
      cookie: colleague.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId, 'custom') }),
    })
    expect(custom.status).toBe(201)
    const body = (await custom.json()) as { poster: { status: string } }
    expect(body.poster.status).toBe('ready')

    // ...and the figure is filed under the run's owner, so deleting their run reclaims it.
    const owned = await apiFetch(`/api/v1/revisions/${revisionId}/posters`, { cookie: owner.cookie })
    const ownedBody = (await owned.json()) as { posters: { kind: string }[] }
    expect(ownedBody.posters.filter((poster) => poster.kind === 'custom')).toHaveLength(1)
  })

  it('generates the automatic poster on a colleague’s revision that has none', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    const auto = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: colleague.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(auto.status).toBe(201)

    // The one automatic figure per revision, whoever asked for it: the owner polling the same
    // endpoint is handed the colleague's render rather than making a second one.
    const again = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: owner.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })
    expect(again.status).toBe(200)
    expect(((await again.json()) as { created: boolean }).created).toBe(false)
  })

  it('edits the memo and the tags', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)

    const patched = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: colleague.cookie,
      body: JSON.stringify({ memo: '同僚による注記', tags: ['再測定'] }),
    })
    expect(patched.status).toBe(200)

    const detail = await apiFetch(`/api/v1/runs/${runId}`, { cookie: owner.cookie })
    const body = (await detail.json()) as { run: { memo: string; tags: string[] } }
    expect(body.run.memo).toBe('同僚による注記')
    expect(body.run.tags).toEqual(['再測定'])
  })

  it('finds a colleague’s run by the tag a colleague put on it', async () => {
    // Tags are the whole of the grouping story since the projects entity was removed, so the pair
    // that matters is asserted together: a member may tag somebody else's run, and that tag is then
    // a filter over the *team* listing rather than only over their own. A tag that could be written
    // across the workspace but only searched within one member's runs would be the same
    // half-shared shape the project field had.
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)

    const tagged = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: colleague.cookie,
      body: JSON.stringify({ tags: ['微小重力2026'] }),
    })
    expect(tagged.status).toBe(200)

    const found = await apiFetch('/api/v1/workspace/runs?tag=微小重力2026', { cookie: colleague.cookie })
    expect(found.status).toBe(200)
    const body = (await found.json()) as { runs: { id: string; tags: string[] }[] }
    expect(body.runs.map((entry) => entry.id)).toContain(runId)
  })
})

describe('what a Researcher still cannot do to a colleague’s work', () => {
  it('cannot delete the run — 404, not 403', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId } = await populatedRun(owner)

    const destroy = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: colleague.cookie })
    expect(destroy.status).toBe(404)
    const body = (await destroy.json()) as { error: { code: string } }
    // Not FORBIDDEN. A refusal that distinguishes "yours" from "someone else's" is the same
    // oracle whether it is refusing a read or a delete.
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND')

    // ...and the run is untouched: the colleague can still read it.
    expect((await apiFetch(`/api/v1/runs/${runId}`, { cookie: colleague.cookie })).status).toBe(200)
  })

  it('cannot upload or delete the original CSV backup — 404, not 403', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId } = await populatedRun(owner)

    const upload = await uploadSource(colleague, runId)
    expect(upload.status).toBe(404)

    const remove = await apiFetch(`/api/v1/runs/${runId}/source`, {
      method: 'DELETE',
      cookie: colleague.cookie,
    })
    expect(remove.status).toBe(404)

    // The owner's backup is still there, and still downloadable by the colleague who may read it.
    expect((await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: colleague.cookie })).status).toBe(200)
  })

  it('cannot add a revision to it, or file a snapshot under one', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    // A revision records who analysed what with which settings. Appending to a colleague's
    // provenance chain would make that question have two answers.
    const created = await apiFetch(`/api/v1/runs/${runId}/revisions`, {
      method: 'POST',
      cookie: colleague.cookie,
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
    expect(created.status).toBe(404)

    expect((await uploadSnapshot(colleague, revisionId)).status).toBe(404)
  })
})

/* ------------------------------------------------------------------------------------------- */
/* Administrators                                                                                */
/* ------------------------------------------------------------------------------------------- */

describe('an Admin', () => {
  it('deletes a colleague’s run, and the run is gone for everyone', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const { runId, revisionId } = await populatedRun(owner)

    const destroy = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: admin.cookie })
    expect(destroy.status).toBe(200)

    expect((await apiFetch(`/api/v1/runs/${runId}`, { cookie: owner.cookie })).status).toBe(404)
    expect((await apiFetch(`/api/v1/revisions/${revisionId}`, { cookie: admin.cookie })).status).toBe(404)
  })

  it('deletes a colleague’s original CSV backup', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const { runId } = await populatedRun(owner)

    const removed = await apiFetch(`/api/v1/runs/${runId}/source`, {
      method: 'DELETE',
      cookie: admin.cookie,
    })
    expect(removed.status).toBe(200)
    expect(((await removed.json()) as { objectsDeleted: number }).objectsDeleted).toBe(1)

    // The bytes are gone and the OWNER's quota — not the administrator's — got the space back.
    expect((await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: owner.cookie })).status).toBe(404)
    const adminQuota = (await (await apiFetch('/api/v1/me', { cookie: admin.cookie })).json()) as {
      quota: { bytesUsed: number }
    }
    expect(adminQuota.quota.bytesUsed).toBe(0)
  })

  it('still cannot add a revision to a colleague’s run', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)

    expect((await uploadSnapshot(admin, revisionId)).status).toBe(404)
  })

  it('reads research data through the member routes, never through /admin', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const { revisionId } = await populatedRun(owner)

    // The widened read goes through the ordinary door, where it is resolved and audited.
    expect(
      (await apiFetch(`/api/v1/revisions/${revisionId}/snapshot`, { cookie: admin.cookie })).status,
    ).toBe(200)

    // The admin surface answers with metadata and nothing else: sizes, counts, names.
    const storage = await apiFetch('/api/v1/admin/storage', { cookie: admin.cookie })
    expect(storage.status).toBe(200)
    const body = await storage.text()
    expect(body).not.toContain('"series"')
    expect(body).not.toContain('sourceSha256')
    const parsed = JSON.parse(body) as { perUser: { userId: string; bytesUsed: number }[] }
    expect(parsed.perUser.some((entry) => entry.userId === owner.userId)).toBe(true)
  })
})

/* ------------------------------------------------------------------------------------------- */
/* Viewers: unchanged, and the reason 404 still matters                                          */
/* ------------------------------------------------------------------------------------------- */

describe('a Viewer sees only their own runs', () => {
  it('is refused every cross-user read, with 404 rather than 403', async () => {
    const owner = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    const { runId, revisionId, posterId } = await populatedRun(owner)

    // Every door a Viewer holds the capability to knock on. The resource resolver is what refuses
    // them, and it refuses as an absence.
    const doors = [
      `/api/v1/runs/${runId}`,
      `/api/v1/runs/${runId}/revisions`,
      `/api/v1/revisions/${revisionId}`,
      `/api/v1/revisions/${revisionId}/snapshot`,
      `/api/v1/revisions/${revisionId}/posters`,
      `/api/v1/posters/${posterId}/image`,
    ]

    for (const door of doors) {
      const response = await apiFetch(door, { cookie: viewer.cookie })
      expect(response.status, door).toBe(404)
      const body = (await response.json()) as { error: { code: string } }
      // 403 here would tell a Viewer precisely which run ids the rest of the team holds.
      expect(body.error.code, door).toBe('RESOURCE_NOT_FOUND')
    }

    // The original CSV is refused one step earlier, at the capability, which leaks nothing: a
    // Viewer holds no raw:download, so the answer is the same for a run that does not exist.
    const source = await apiFetch(`/api/v1/runs/${runId}/source`, { cookie: viewer.cookie })
    expect(source.status).toBe(403)
    const missing = await apiFetch('/api/v1/runs/01NOSUCHRUNIDATALL/source', { cookie: viewer.cookie })
    expect(await source.json()).toEqual(await missing.json())
  })

  it('cannot annotate a colleague’s run', async () => {
    const owner = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    const runId = await createRun(owner)

    const patched = await apiFetch(`/api/v1/runs/${runId}`, {
      method: 'PATCH',
      cookie: viewer.cookie,
      body: JSON.stringify({ memo: 'mine now' }),
    })
    // Refused at the capability, before the resource is ever resolved: a Viewer holds no
    // analysis:update at all.
    expect(patched.status).toBe(403)
  })

  it('sees their own runs, and only their own, in the listing', async () => {
    const owner = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    await createRun(owner)

    const list = await apiFetch('/api/v1/runs', { cookie: viewer.cookie })
    expect(list.status).toBe(200)
    expect(((await list.json()) as { runs: unknown[] }).runs).toHaveLength(0)
  })
})

interface GalleryRow {
  id: string
  ownerUserId: string
  ownerDisplayName: string
  runCode: string
}

async function gallery(user: TestUser, query = ''): Promise<Response> {
  return apiFetch(`/api/v1/workspace/runs${query}`, { cookie: user.cookie })
}

describe('the two listings mean two different things', () => {
  it('GET /runs stays the caller’s own, and does not fold a colleague’s runs into it', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const runId = await createRun(owner)

    const list = await apiFetch('/api/v1/runs', { cookie: colleague.cookie })
    const body = (await list.json()) as { runs: { id: string }[] }
    // "My runs" has to keep meaning mine. The team gallery is the other endpoint.
    expect(body.runs.map((run) => run.id)).not.toContain(runId)

    // ...and the run is nonetheless readable by id.
    expect((await apiFetch(`/api/v1/runs/${runId}`, { cookie: colleague.cookie })).status).toBe(200)
  })

  it('GET /workspace/runs shows a colleague’s run, named with its owner', async () => {
    const owner = await createUser({ displayName: '田中' })
    const colleague = await createUser()
    const runId = await createRun(owner)
    const ownRunId = await createRun(colleague, '260812a_data.csv')

    const response = await gallery(colleague)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { runs: GalleryRow[] }

    const theirs = body.runs.find((run) => run.id === runId)
    expect(theirs).toBeDefined()
    expect(theirs?.ownerUserId).toBe(owner.userId)
    // A gallery that cannot say whose run this is is a list with the somebody left out — and the
    // display name is the only identity AAT has.
    expect(theirs?.ownerDisplayName).toBe('田中')

    // The caller's own runs are in it too: it is the workspace, not "everyone but me".
    expect(body.runs.map((run) => run.id)).toContain(ownRunId)
  })

  it('narrows to one member on request', async () => {
    const first = await createUser({ displayName: '一人目' })
    const second = await createUser({ displayName: '二人目' })
    const colleague = await createUser()
    const firstRun = await createRun(first)
    const secondRun = await createRun(second)

    const response = await gallery(colleague, `?ownerUserId=${first.userId}`)
    const body = (await response.json()) as { runs: GalleryRow[] }
    expect(body.runs.map((run) => run.id)).toContain(firstRun)
    expect(body.runs.map((run) => run.id)).not.toContain(secondRun)
  })

  /*
   * The filter assertions below are scoped with `ownerUserId`, not because the filters need it but
   * because this pool keeps ONE database for the whole run: the gallery legitimately contains every
   * run every other test created. Narrowing to a fixture owner is what makes an exact expectation
   * possible at all — and it exercises two filters composing, which is the shape a gallery issues.
   */
  it('applies the same search, date and tag filters as the caller’s own listing', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const scope = `?ownerUserId=${owner.userId}`
    await createRun(owner, '260811a_data.csv')
    const august12 = await createRun(owner, '260812b_data.csv')
    await apiFetch(`/api/v1/runs/${august12}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      body: JSON.stringify({ tags: ['ギャラリー検証'] }),
    })

    const searched = (await (await gallery(colleague, `${scope}&search=260812`)).json()) as {
      runs: GalleryRow[]
    }
    expect(searched.runs.map((run) => run.runCode)).toEqual(['260812b'])

    const dated = (await (await gallery(colleague, `${scope}&from=2026-08-12`)).json()) as {
      runs: GalleryRow[]
    }
    expect(dated.runs.map((run) => run.runCode)).toEqual(['260812b'])

    const tagged = (await (await gallery(colleague, `${scope}&tag=ギャラリー検証`)).json()) as {
      runs: GalleryRow[]
    }
    expect(tagged.runs.map((run) => run.runCode)).toEqual(['260812b'])
  })

  it('is paginated and bounded, across owners', async () => {
    const first = await createUser()
    const second = await createUser()
    const colleague = await createUser()
    const mine = [
      await createRun(first, '260811a_data.csv'),
      await createRun(second, '260811b_data.csv'),
      await createRun(second, '260812c_data.csv'),
    ]

    // Walk the whole gallery two rows at a time. The property is the keyset one — every row appears
    // exactly once and the cursor never stalls — and it has to hold across owners, which it does
    // because a ULID is unique deployment-wide rather than per user.
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (; pages < 60; pages++) {
      const url: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`
      const body = (await (await gallery(colleague, url)).json()) as {
        runs: GalleryRow[]
        nextCursor: string | null
      }
      expect(body.runs.length).toBeLessThanOrEqual(2)
      seen.push(...body.runs.map((run) => run.id))
      cursor = body.nextCursor
      if (cursor === null) break
    }
    expect(cursor).toBeNull()
    expect(new Set(seen).size).toBe(seen.length)
    for (const runId of mine) expect(seen).toContain(runId)

    // The page size is bounded, whatever the client asks for.
    expect((await gallery(colleague, '?limit=1000')).status).toBe(400)
  })

  it('never lists a deleted run', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId } = await populatedRun(owner)

    const before = (await (await gallery(colleague)).json()) as { runs: GalleryRow[] }
    expect(before.runs.map((run) => run.id)).toContain(runId)

    expect((await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(
      200,
    )

    const after = (await (await gallery(colleague)).json()) as { runs: GalleryRow[] }
    expect(after.runs.map((run) => run.id)).not.toContain(runId)
  })

  it('refuses a Viewer outright rather than quietly showing them their own', async () => {
    const owner = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    await createRun(owner)

    const response = await gallery(viewer)
    // Refused, not narrowed. A Viewer handed a short list has no way to know they were not shown
    // the team's — and a narrowed list would make this endpoint an existence oracle by omission.
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { code: string; details?: { required?: string } } }
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details?.required).toBe('workspace:read')

    // ...and the refusal is identical whether or not any colleague's run exists.
    const otherViewer = await createUser({ role: 'Viewer' })
    const empty = await gallery(otherViewer)
    expect(await empty.json()).toEqual(body)
  })

  it('is refused to an anonymous caller', async () => {
    const response = await apiFetch('/api/v1/workspace/runs')
    expect(response.status).toBe(401)
  })

  it('serves an Admin the same gallery', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const runId = await createRun(owner)

    const body = (await (await gallery(admin)).json()) as { runs: GalleryRow[] }
    expect(body.runs.map((run) => run.id)).toContain(runId)
  })
})

/* ------------------------------------------------------------------------------------------- */
/* Invariants that survive the widening                                                          */
/* ------------------------------------------------------------------------------------------- */

describe('a deleted run stays invisible through every door', () => {
  it('is gone for its owner, for a colleague and for an administrator alike', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const { runId, revisionId, posterId } = await populatedRun(owner)

    expect((await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: owner.cookie })).status).toBe(
      200,
    )

    const doors = [
      `/api/v1/runs/${runId}`,
      `/api/v1/runs/${runId}/revisions`,
      `/api/v1/runs/${runId}/source`,
      `/api/v1/revisions/${revisionId}`,
      `/api/v1/revisions/${revisionId}/snapshot`,
      `/api/v1/revisions/${revisionId}/posters`,
      `/api/v1/posters/${posterId}/image`,
    ]

    for (const caller of [owner, colleague, admin]) {
      for (const door of doors) {
        const response = await apiFetch(door, { cookie: caller.cookie })
        expect(response.status, `${caller.role} ${door}`).toBe(404)
      }
    }
  })

  it('cannot have a poster rendered against it by anyone', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const runId = await createRun(owner)
    const revisionId = await createRevision(owner, runId)
    await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: owner.cookie })

    for (const caller of [owner, colleague, admin]) {
      const response = await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
        method: 'POST',
        cookie: caller.cookie,
        body: JSON.stringify({ spec: posterSpec(revisionId) }),
      })
      expect(response.status, caller.role).toBe(404)
    }
  })
})

describe('the id space is not an enumeration oracle', () => {
  it('answers identically for a nonexistent id and for one a Viewer may not reach', async () => {
    const owner = await createUser()
    const viewer = await createUser({ role: 'Viewer' })
    const { runId, revisionId } = await populatedRun(owner)

    const unauthorised = await apiFetch(`/api/v1/runs/${runId}`, { cookie: viewer.cookie })
    const nonexistent = await apiFetch('/api/v1/runs/01NOSUCHRUNIDATALL', { cookie: viewer.cookie })
    expect(unauthorised.status).toBe(nonexistent.status)
    expect(await unauthorised.json()).toEqual(await nonexistent.json())

    const unauthorisedRevision = await apiFetch(`/api/v1/revisions/${revisionId}`, { cookie: viewer.cookie })
    const nonexistentRevision = await apiFetch('/api/v1/revisions/01NOSUCHREVISION', {
      cookie: viewer.cookie,
    })
    expect(unauthorisedRevision.status).toBe(nonexistentRevision.status)
    expect(await unauthorisedRevision.json()).toEqual(await nonexistentRevision.json())
  })

  it('answers identically for a nonexistent run and one a Researcher may not delete', async () => {
    const owner = await createUser()
    const colleague = await createUser()
    const { runId } = await populatedRun(owner)

    const refused = await apiFetch(`/api/v1/runs/${runId}`, { method: 'DELETE', cookie: colleague.cookie })
    const missing = await apiFetch('/api/v1/runs/01NOSUCHRUNIDATALL', {
      method: 'DELETE',
      cookie: colleague.cookie,
    })
    // The whole point of the widening is that a Researcher can *read* this run. That must not make
    // the refusal to delete it any more informative than a refusal on an id that does not exist.
    expect(refused.status).toBe(missing.status)
    expect(await refused.json()).toEqual(await missing.json())
  })
})

describe('spec provenance', () => {
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
