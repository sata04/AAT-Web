/// <reference path="../../worker-configuration.d.ts" />

/**
 * The Worker entry point used by the end-to-end suite, and only by it.
 *
 * The application Worker is imported and used **unmodified** — `worker/index.ts`'s own `fetch` is
 * what answers every `/api/*` request the browser makes, so the suite exercises the real routing,
 * the real Better Auth instance, the real authorization middleware and the real D1 statements. Two
 * things are added around it, both of which exist because a browser test needs a way in that
 * production deliberately does not have:
 *
 *  1. **`/__e2e__/sql`** — arbitrary SQL against the local D1, behind a per-run random token. This
 *     is the harness's stand-in for `wrangler d1 execute --local`, which cannot be used while
 *     `wrangler dev` holds the same SQLite file open. It is what lets a test insert the bootstrap
 *     invitation of a fresh deployment exactly as docs/deployment.md instructs an operator to, and
 *     what lets a test read the audit log back and assert on it. It is not mounted unless
 *     `E2E_HARNESS_TOKEN` is set, and that var only exists in `e2e/wrangler.e2e.jsonc`.
 *
 *  2. **`PosterRendererContainer`** — replaced with an HTTP proxy to a real poster-renderer
 *     container running under Docker on the host. The production class drives a Cloudflare
 *     Container through `ctx.container`, which `workerd` has no equivalent of outside Cloudflare's
 *     platform; everything on the AAT side of that boundary — `renderViaContainer`, the
 *     `POSTER_BUSY` translation, the R2 write, the `poster_figures` bookkeeping — is unchanged and
 *     is what the suite is testing. The bytes that come back are produced by the pinned Python +
 *     Matplotlib image, not by a fixture.
 *
 * Nothing here is bundled into a deployment: `wrangler.jsonc` still names `worker/index.ts`, and
 * this file is reached only through `e2e/wrangler.e2e.jsonc`.
 */

import { DurableObject } from 'cloudflare:workers'
import app from '../../worker/index.ts'

/** The vars this entry adds on top of the application's `Env`. Both are injected per run. */
type HarnessEnv = Env & {
  /** Shared secret for `/__e2e__/*`. Absent in every configuration but the e2e one. */
  E2E_HARNESS_TOKEN?: string
  /** Base URL of the poster renderer container, e.g. `http://127.0.0.1:8099`. */
  POSTER_RENDERER_URL?: string
}

const HARNESS_PREFIX = '/__e2e__/'

interface SqlRequest {
  sql: string
  params?: unknown[]
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The harness API.
 *
 * Fails closed twice over: no token configured means the routes do not exist, and a wrong token is
 * refused before the body is read.
 */
async function handleHarness(request: Request, env: HarnessEnv): Promise<Response> {
  const expected = env.E2E_HARNESS_TOKEN
  if (typeof expected !== 'string' || expected.length === 0) {
    return json({ error: 'harness disabled' }, 404)
  }
  if (request.headers.get('x-e2e-token') !== expected) {
    return json({ error: 'forbidden' }, 403)
  }

  const url = new URL(request.url)

  if (url.pathname === `${HARNESS_PREFIX}ready`) {
    // Answers only once the D1 binding is usable, which is what the harness waits on rather than
    // on a fixed delay.
    await env.DB.prepare('select 1').first()
    return json({ ok: true })
  }

  if (url.pathname === `${HARNESS_PREFIX}renderer`) {
    // Reaches the renderer the way the application does — through the Durable Object stub — so the
    // harness waits on the path it is about to test rather than on the container's published port.
    const stub = env.POSTER_RENDERER.get(env.POSTER_RENDERER.idFromName('poster-renderer'))
    const response = await stub.fetch('http://renderer/health')
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  }

  if (url.pathname === `${HARNESS_PREFIX}sql` && request.method === 'POST') {
    const body = (await request.json()) as SqlRequest
    if (typeof body.sql !== 'string' || body.sql.length === 0) {
      return json({ error: 'sql is required' }, 400)
    }
    const statement = env.DB.prepare(body.sql)
    const bound =
      Array.isArray(body.params) && body.params.length > 0 ? statement.bind(...body.params) : statement
    const result = await bound.all()
    return json({ results: result.results, meta: result.meta })
  }

  return json({ error: 'no such harness endpoint' }, 404)
}

export default {
  async fetch(request: Request, env: HarnessEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(HARNESS_PREFIX)) {
      return handleHarness(request, env)
    }
    return app.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<HarnessEnv>

/**
 * Stands in for the Cloudflare Container binding by talking to the same image over HTTP.
 *
 * The contract this must honour is the one `worker/services/poster.ts` depends on: `POST /render`
 * answers with PNG bytes plus `x-poster-renderer-version` and `x-poster-preset-version`, a 429 is
 * backpressure, and anything else is a render failure carrying a JSON `code`. Since the renderer
 * refuses a chunked request body outright (it enforces its size cap from `Content-Length` before
 * reading a byte), the body is buffered here rather than streamed — a streamed `request.body` would
 * be sent chunked and rejected with `LENGTH_REQUIRED`, which would look like a renderer fault.
 */
export class PosterRendererContainer extends DurableObject<HarnessEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/render' && url.pathname !== '/health') {
      return new Response('not found', { status: 404 })
    }

    const base = this.env.POSTER_RENDERER_URL
    if (typeof base !== 'string' || base.length === 0) {
      return new Response(JSON.stringify({ code: 'POSTER_RENDERER_UNAVAILABLE' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }

    const headers = new Headers()
    const contentType = request.headers.get('content-type')
    if (contentType !== null) headers.set('content-type', contentType)

    const init: RequestInit = { method: request.method, headers }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = new Uint8Array(await request.arrayBuffer())
    }

    try {
      const response = await fetch(`${base}${url.pathname}`, init)
      // Rebuilt rather than returned directly so the body is a plain buffer: the DO boundary does
      // not carry a streaming body back to the caller reliably in local dev.
      const bytes = await response.arrayBuffer()
      return new Response(bytes, { status: response.status, headers: response.headers })
    } catch (error) {
      return new Response(
        JSON.stringify({ code: 'POSTER_RENDER_FAILED', reason: (error as Error).message }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  }
}
