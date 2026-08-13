/**
 * The only Pages Function.
 *
 * Everything under `/api/*` is handed to the private `aat-api` Worker over a
 * Service binding. Nothing else in this project runs on Pages.
 *
 * ## Why this exists at all
 *
 * The browser's origin has to be the same origin the auth handler answers on.
 * `src/auth/client.ts` and `src/runs/api.ts` use relative paths with
 * `credentials: 'include'`, Better Auth compares `AAT_TRUSTED_ORIGINS` by exact
 * equality, and a WebAuthn RP ID must be the origin's registrable domain — and
 * because both `pages.dev` and `workers.dev` are on the Public Suffix List,
 * a Pages front end calling a Worker on its own hostname would have *no* shared
 * RP ID at all. Passkeys would be impossible, not merely awkward. Forwarding
 * inside the Pages origin keeps the whole thing same-origin.
 *
 * ## Forward the request object, do not rebuild it
 *
 * `context.request` already carries the client's method, headers (Cookie
 * included), body and — the part that matters — a fully-qualified URL on the
 * public origin. The Worker's Better Auth instance reads that URL to decide what
 * origin it is serving, so reconstructing the request (`new Request('/api/…')`)
 * would drop the cookies and hand it an origin that fails its own trusted-origin
 * check. It would also be rejected outright: a service binding is not an HTTP
 * request over the network, so a manually constructed request must carry a
 * fully-qualified hostname.
 *
 * ## Why it catches its own errors
 *
 * Pages replaces an *unhandled* Function exception with a static asset. With SPA
 * fallback on, that asset is `index.html` — so a crash in the Worker would reach
 * the browser as `200 text/html` where `fetch(...).json()` expects JSON, and the
 * client would report a parse error instead of the failure that happened. The
 * catch below turns that into the error envelope the client already knows how to
 * read (`packages/shared/src/errors.ts`), which is the difference between an
 * incident that is diagnosable and one that is not.
 *
 * `wrangler pages dev` does NOT reproduce that swallowing — it returns the stack
 * trace — so this is one of the places where the local suite cannot tell you the
 * production behaviour is right. See docs/ci.md.
 */

interface Env {
  /** The private `aat-api` Worker. No route, no workers.dev; reachable only from here. */
  AAT_API: Fetcher
}

export const onRequest: PagesFunction<Env> = async (context) => {
  try {
    return await context.env.AAT_API.fetch(context.request)
  } catch (error) {
    // 502, not 500: the Pages Function is reachable and the failure is behind it.
    // Shape matches `ApiError`'s wire format so the client's existing handling
    // applies without a special case.
    const detail = error instanceof Error ? error.message : String(error)
    return new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: detail } }), {
      status: 502,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        // Never cached: this is a transient infrastructure answer, and a cached
        // 502 on /api/auth/* would look like a broken account.
        'cache-control': 'no-store',
      },
    })
  }
}
