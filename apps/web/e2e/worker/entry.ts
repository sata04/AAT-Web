/// <reference path="../../worker-configuration.d.ts" />

/**
 * The Worker entry point used by the end-to-end suite, and only by it.
 *
 * The application Worker is imported and used **unmodified** — `worker/index.ts`'s own `fetch` is
 * what answers every `/api/*` request the browser makes, so the suite exercises the real routing,
 * the real Better Auth instance, the real authorization middleware and the real D1 statements. One
 * thing is added around it, which exists because a browser test needs a way in that production
 * deliberately does not have:
 *
 *  1. **`/__e2e__/sql`** — arbitrary SQL against the local D1, behind a per-run random token. This
 *     is the harness's stand-in for `wrangler d1 execute --local`, which cannot be used while
 *     `wrangler dev` holds the same SQLite file open. It is what lets a test insert the bootstrap
 *     invitation of a fresh deployment exactly as docs/deployment.md instructs an operator to, and
 *     what lets a test read the audit log back and assert on it. It is not mounted unless
 *     `E2E_HARNESS_TOKEN` is set, and that var only exists in `e2e/wrangler.e2e.jsonc`.
 *
 * Nothing here is bundled into a deployment: `wrangler.jsonc` still names `worker/index.ts`, and
 * this file is reached only through `e2e/wrangler.e2e.jsonc`.
 */

import app from '../../worker/index.ts'

/** The var this entry adds on top of the application's `Env`. Injected per run. */
type HarnessEnv = Env & {
  /** Shared secret for `/__e2e__/*`. Absent in every configuration but the e2e one. */
  E2E_HARNESS_TOKEN?: string
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
