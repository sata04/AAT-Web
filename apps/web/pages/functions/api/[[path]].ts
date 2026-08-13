/**
 * The only Pages Function.
 *
 * Everything under `/api/*` is handed to the private `aat-api` Worker over a
 * Service binding. Nothing else in this project runs on Pages, and
 * `../../../public/_routes.json` is what keeps it that way — without it Pages
 * generates a route table that sends static requests here too.
 *
 * ## Why the API is proxied rather than called directly
 *
 * The browser's origin has to be the origin the auth handler answers on.
 * `src/auth/client.ts` and `src/runs/api.ts` use relative paths with
 * `credentials: 'include'`, Better Auth compares trusted origins by exact
 * equality, and a WebAuthn RP ID must be the origin's registrable domain. Both
 * of Cloudflare's shared deployment domains are on the Public Suffix List, so a
 * front end on one and an API on the other would have *no* RP ID in common:
 * passkeys would be impossible, not merely awkward. Forwarding inside one origin
 * avoids the question entirely.
 *
 * ## Forward the request object; do not rebuild it
 *
 * `context.request` already carries the client's method, headers (Cookie
 * included), body, and a fully-qualified URL on the public origin. Better Auth
 * reads that URL to decide what it is serving and derives its RP ID from it when
 * one is not configured, so a reconstructed request would drop the cookies and
 * quietly change the relying party. A service binding also rejects a manually
 * constructed request that has no fully-qualified hostname.
 *
 * ## Why it catches its own errors
 *
 * Pages replaces an *unhandled* Function exception with a static asset. With SPA
 * fallback on, that asset is `index.html` — so a crash behind the binding would
 * reach the browser as `200 text/html` where the client calls `.json()`, and the
 * user would be shown a parse error instead of the failure that happened. This
 * is one of three documented ways the split turns a fail-closed API into a
 * fail-open one, and the only one the Function itself can close.
 *
 * `wrangler pages dev` does NOT reproduce that swallowing — it returns the stack
 * trace — so no local run can tell you this is right. See docs/ci.md.
 */

/**
 * The Workers runtime types are not in scope here.
 *
 * `apps/web/worker-configuration.d.ts` is generated for the Worker, and pulling
 * `@cloudflare/workers-types` in for one file would add a dependency to the
 * package that `docs/supply-chain.md` asks to be kept small. What this file
 * actually uses is two shapes, so they are written down.
 */
interface ServiceBinding {
  fetch(request: Request): Promise<Response>
}

interface Env {
  /** The private `aat-api` Worker. No route, no public subdomain; reachable only from here. */
  AAT_API: ServiceBinding
}

interface PagesContext {
  request: Request
  env: Env
}

export async function onRequest(context: PagesContext): Promise<Response> {
  try {
    return await context.env.AAT_API.fetch(context.request)
  } catch (error) {
    /*
     * The body is the canonical `INTERNAL` envelope, deliberately.
     *
     * An invented code such as `UPSTREAM_UNAVAILABLE` would not survive the
     * client: `readErrorBody` in src/cloud/gateway.ts keeps a code only when
     * `isErrorCode` recognises it, so an unknown one is discarded and collapses
     * to `INTERNAL` anyway — while an English exception string in `message`
     * would be rendered verbatim into a Japanese interface and leak internals
     * with it. Sending `INTERNAL` with the localised message says the same thing
     * honestly, and `INTERNAL` is in the gateway's RETRYABLE set, so the user is
     * offered a retry rather than a dead end.
     *
     * 502 rather than 404: 404 is how this codebase says "this deployment has no
     * cloud half", which is a supported configuration and degrades silently to
     * local-only. A reachable front door with a broken Worker behind it is a
     * different statement, and quietly borrowing the other one would mislead
     * whoever is trying to find out why runs stopped syncing.
     *
     * The detail goes to Workers Logs, where an operator can read it, and not to
     * the browser, where a user cannot act on it.
     */
    console.error('aat-api service binding failed', error)
    return new Response(
      JSON.stringify({
        error: {
          code: 'INTERNAL',
          message: 'クラウドに接続できません。ローカルの解析結果はそのまま利用できます。',
        },
      }),
      {
        status: 502,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // A cached 502 on /api/auth/* would look like a broken account.
          'cache-control': 'no-store',
        },
      },
    )
  }
}
