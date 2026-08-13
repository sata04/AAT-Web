/**
 * Every path the browser builds must be a path the Worker serves.
 *
 * This test exists because that was not true for a year. `src/cloud/gateway.ts` posted snapshots to
 * `/api/v1/analyses` and asked for posters at `/api/v1/analyses/:id/poster`; the Worker served
 * neither, and has never served either. Nothing failed loudly, and that is the whole lesson: a path
 * the router does not know answers 404, the gateway reads 404 as "this deployment has no cloud
 * half" — a supported configuration — and the cloud lane reports クラウド機能は利用できません while
 * the local analysis carries on working perfectly. A typo and an undeployed Worker are
 * indistinguishable from the browser, so cloud sync could be completely broken and look exactly
 * like a feature nobody had turned on.
 *
 * So the assertion is made against the router rather than against a list of strings a human keeps
 * in step. Two halves:
 *
 *  - **The paths are collected by calling the gateway**, with `fetch` stubbed out to record what it
 *    was asked for. Not by re-deriving them, not by reading the source — by running the same
 *    template literals the application runs, so a typo anywhere in a path expression is caught,
 *    including in one built from three fragments and an `encodeURIComponent`.
 *  - **The routes come from `worker/routes/*.ts`**, mounted the way `worker/index.ts` mounts them,
 *    with the mount table *read out of that file* rather than restated here. A mirror of a routing
 *    table is a thing that drifts; a mirror that fails the build when the original changes is a
 *    thing that gets updated. Adding a router in `index.ts` fails this test with "unknown router"
 *    until it is registered below, which is the loud version of the failure this file is about.
 *
 * `worker/index.ts` itself is deliberately not imported: it re-exports the Durable Object, which
 * imports `cloudflare:workers`, a specifier that does not resolve in a Node test. Its *routing* is
 * still what is under test, because that is what is parsed out of it.
 *
 * Better Auth's `/api/auth/*` prefix is out of scope here — it is mounted as a catch-all, so every
 * path under it matches by construction and there is nothing a typo could break that this could
 * detect.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  asFullResolutionSeries,
  buildAutoPosterPlotSpec,
  buildPosterPlotSpec,
  type PosterPlotSpec,
} from '@aat/plot-spec'
import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as gateway from '../../src/cloud/gateway.ts'
import { adminRoutes } from '../../worker/routes/admin.ts'
import { meRoutes } from '../../worker/routes/me.ts'
import { posterRoutes } from '../../worker/routes/posters.ts'
import { revisionRoutes } from '../../worker/routes/revisions.ts'
import { projectRoutes, runRoutes, workspaceRoutes } from '../../worker/routes/runs.ts'

/* ------------------------------------------------------------------------------------------- */
/* The router, assembled from the entry point's own mount table                                  */
/* ------------------------------------------------------------------------------------------- */

/** The routers `worker/index.ts` may name, by the identifier it names them with. */
// biome-ignore lint/suspicious/noExplicitAny: Hono's generics differ per router; only paths matter.
const ROUTERS: Readonly<Record<string, Hono<any>>> = {
  meRoutes,
  runRoutes,
  projectRoutes,
  revisionRoutes,
  posterRoutes,
  adminRoutes,
  workspaceRoutes,
}

interface RoutePattern {
  method: string
  /** A Hono path pattern: literal segments, plus `:param` segments that match anything non-empty. */
  pattern: string
}

function workerRoutePatterns(): RoutePattern[] {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(path.resolve(here, '../../worker/index.ts'), 'utf8')

  const base = /app\.route\(\s*'([^']+)'\s*,\s*v1\s*\)/.exec(source)?.[1]
  if (base === undefined) {
    throw new Error('worker/index.ts no longer mounts the v1 router as `app.route(<base>, v1)`')
  }

  const mounts = [...source.matchAll(/v1\.route\(\s*'([^']*)'\s*,\s*(\w+)\s*\)/g)]
  if (mounts.length === 0) throw new Error('worker/index.ts registered no v1 routers')

  const v1 = new Hono()
  for (const [, prefix, name] of mounts) {
    const router = name === undefined ? undefined : ROUTERS[name]
    if (router === undefined || prefix === undefined) {
      throw new Error(
        `worker/index.ts mounts an unknown router \`${name}\`. Add it to ROUTERS in this test — ` +
          'the gateway path check is only as complete as this table.',
      )
    }
    v1.route(prefix, router)
  }

  const app = new Hono()
  app.route(base, v1)

  // `ALL` entries are the `use('*')` middleware chains (session, database, capability). They match
  // every path under their prefix, including ones no handler serves, so counting them as routes is
  // exactly how a missing endpoint would pass this test.
  return app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => ({ method: route.method, pattern: route.path }))
}

function patternMatches(pattern: string, requestPath: string): boolean {
  const expected = pattern.split('/')
  const actual = requestPath.split('/')
  if (expected.length !== actual.length) return false
  return expected.every((segment, index) => {
    const value = actual[index] ?? ''
    return segment.startsWith(':') ? value.length > 0 : segment === value
  })
}

function isServed(routes: readonly RoutePattern[], method: string, requestPath: string): boolean {
  return routes.some((route) => route.method === method && patternMatches(route.pattern, requestPath))
}

/* ------------------------------------------------------------------------------------------- */
/* The paths, collected by running the gateway                                                   */
/* ------------------------------------------------------------------------------------------- */

interface RecordedRequest {
  method: string
  /** Path only: a query string is data, and the router does not route on it. */
  path: string
}

const recorded: RecordedRequest[] = []
const realFetch = globalThis.fetch

beforeEach(() => {
  recorded.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://aat.test')
    recorded.push({ method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
})

/** A valid spec, built the way the application builds one, so this is not a hand-shaped object. */
function specFor(revisionId: string, kind: 'auto' | 'custom'): PosterPlotSpec {
  const time = Float64Array.from([0, 0.001, 0.002, 0.003])
  const values = Float64Array.from([0.0001, 0.0002, 0.00015, 0.0001])
  const source = { inner: asFullResolutionSeries(time, values) }
  if (kind === 'auto') {
    return buildAutoPosterPlotSpec({ analysisRevisionId: revisionId, runCode: '260811a', source })
  }
  return buildPosterPlotSpec({
    analysisRevisionId: revisionId,
    runCode: '260811a',
    series: 'inner',
    source,
    xMin: 0,
    xMax: 0.5,
  })
}

/**
 * Every gateway call that reaches the network, invoked once.
 *
 * Adding a function to `gateway.ts` without adding it here does not make this test fail — nothing
 * can detect a call that was never written. What it does mean is that the new path is unguarded,
 * which is what `every exported request builder is exercised` below is for: it fails when the
 * module grows a request-shaped export that this list does not call.
 */
async function callEveryEndpoint(): Promise<void> {
  const revisionId = 'rev_01J000000000000000000000'
  const runId = 'run_01J000000000000000000000'
  const posterId = 'pos_01J000000000000000000000'
  const userId = 'usr_01J000000000000000000000'

  await gateway.fetchMe()
  await gateway.fetchMyPasskeys()
  await gateway.deleteMyPasskey('pk_1')

  await gateway.listRuns({ search: '260811', limit: 10 })
  await gateway.listWorkspaceRuns({ search: '260811', limit: 10 })
  await gateway.createRun({ originalFilename: '260811a_data.csv' })
  await gateway.fetchRun(runId)
  await gateway.updateRun(runId, { memo: 'memo' })
  await gateway.deleteRun(runId)
  await gateway.listProjects()

  await gateway.listRevisions(runId)
  await gateway.createRevision(runId, {
    sourceSha256: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    config: DEFAULT_ANALYSIS_CONFIG,
    engineVersion: '1.0.0',
    snapshotFormatVersion: 1,
    metrics: {
      windowSize: 0.1,
      inner: { mean: 0.0001, std: 0.00002, startTime: 1.2 },
      drag: { mean: 'NaN', std: null, startTime: null },
      innerSampleCount: 1450,
      dragSampleCount: 0,
      warningCount: 0,
    },
  })
  await gateway.fetchRevision(revisionId)
  await gateway.uploadSnapshot(revisionId, new Uint8Array([1, 2, 3]), {
    declaredBytes: 3,
    sha256: 'c'.repeat(64),
    format: 'json.gz',
  })

  await gateway.listPosters(revisionId)
  await gateway.requestAutoPoster(revisionId, specFor(revisionId, 'auto'))
  await gateway.createCustomPoster(revisionId, specFor(revisionId, 'custom'))
  await gateway.retryPoster(posterId, specFor(revisionId, 'auto'))

  await gateway.listAdminUsers({ limit: 50 })
  await gateway.updateAdminUser(userId, { role: 'Researcher' })
  await gateway.deleteAdminUser(userId)
  await gateway.listAdminUserPasskeys(userId)
  await gateway.deleteAdminPasskey('pk_1')
  await gateway.createInvitation({
    kind: 'registration',
    role: 'Researcher',
    displayName: 'テスト研究者',
    ttlHours: 24,
  })
  await gateway.listInvitations()
  await gateway.revokeInvitation('inv_1')
  await gateway.fetchStorageReport()
  await gateway.setUserQuota(userId, 1024)
  await gateway.fetchRendererBreaker()
  await gateway.setRendererBreaker(true, 'spend guard')
  await gateway.listAuditLog({ action: 'poster.render' })
}

/* ------------------------------------------------------------------------------------------- */
/* The assertions                                                                                */
/* ------------------------------------------------------------------------------------------- */

describe('gateway paths against the Worker router', () => {
  it('routes every request the gateway makes', async () => {
    const routes = workerRoutePatterns()
    await callEveryEndpoint()

    expect(recorded.length).toBeGreaterThan(20)
    const unserved = recorded.filter((request) => !isServed(routes, request.method, request.path))
    // Named rather than counted: a failure here should print the offending path, because the path
    // is the entire finding.
    expect(unserved.map((request) => `${request.method} ${request.path}`)).toEqual([])
  })

  it('routes the poster image URL, which is built for an <img src> rather than fetched', () => {
    const routes = workerRoutePatterns()
    const url = gateway.posterImageUrl('pos_01J000000000000000000000')
    expect(isServed(routes, 'GET', url)).toBe(true)
  })

  it('fails for a path the Worker does not serve', () => {
    const routes = workerRoutePatterns()
    // The two paths this test was written for. They are asserted absent, not merely "not built any
    // more": if either were ever reintroduced — in the gateway or as a route — the pair of
    // assertions here and above would disagree loudly instead of quietly 404ing in production.
    expect(isServed(routes, 'POST', '/api/v1/analyses')).toBe(false)
    expect(isServed(routes, 'POST', '/api/v1/analyses/rev_1/poster')).toBe(false)
    expect(isServed(routes, 'GET', '/api/v1/analyses/rev_1/poster')).toBe(false)
    // A real route with the wrong method is a mismatch too, which is why the method is part of the
    // check and not just the path.
    expect(isServed(routes, 'POST', '/api/v1/revisions/rev_1/snapshot')).toBe(false)
    expect(isServed(routes, 'PUT', '/api/v1/revisions/rev_1/snapshot')).toBe(true)
  })

  it('leaves no exported request builder unguarded', () => {
    // A path check is only worth what it covers, and nothing can detect a call that was never
    // written — so the module's own surface is the checklist. Adding a function to `gateway.ts`
    // fails here until it is either called in `callEveryEndpoint` or listed as exempt, which is the
    // moment to notice that its path has never been checked against the router.
    const exported = Object.entries(gateway)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
      .sort()

    const expected = [
      // Exempt, for the reasons in the module doc: Better Auth's prefix is a catch-all, and
      // `posterImageUrl` returns a URL rather than making a request. Both have their own assertion.
      'authRequest',
      'posterImageUrl',
      // Everything below is called by `callEveryEndpoint`.
      'createCustomPoster',
      'createInvitation',
      'createRevision',
      'createRun',
      'deleteAdminPasskey',
      'deleteAdminUser',
      'deleteMyPasskey',
      'deleteRun',
      'fetchMe',
      'fetchMyPasskeys',
      'fetchRendererBreaker',
      'fetchRevision',
      'fetchRun',
      'fetchStorageReport',
      'listAdminUserPasskeys',
      'listAdminUsers',
      'listAuditLog',
      'listInvitations',
      'listPosters',
      'listProjects',
      'listRevisions',
      'listRuns',
      'listWorkspaceRuns',
      'requestAutoPoster',
      'retryPoster',
      'revokeInvitation',
      'setRendererBreaker',
      'setUserQuota',
      'updateAdminUser',
      'updateRun',
      'uploadSnapshot',
    ].sort()

    expect(exported).toEqual(expected)
  })
})
