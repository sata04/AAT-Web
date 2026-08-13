/// <reference path="../worker-configuration.d.ts" />

/**
 * The Worker entry point.
 *
 * Routing, in one place:
 *
 *   /api/auth/*   Better Auth (its own router: sessions, sign-out, and the AAT passkey plugin)
 *   /api/v1/*     the versioned application API
 *   everything else  never reaches here — `run_worker_first: ["/api/*"]` in wrangler.jsonc means
 *                    the static asset store answers the SPA without a Worker invocation at all.
 *
 * The API is versioned so that a future CLI or Python client can be added without the browser and
 * that client having to move in lockstep.
 *
 * Nothing here does analysis. The browser owns the numerical pipeline (see
 * docs/web-architecture.md); this Worker owns identity, authorization, quotas, metadata and the
 * poster renderer's leash.
 */

import { ApiError } from '@aat/shared'
import { Hono } from 'hono'
import { getAuth } from './auth/auth.ts'
import { ConfigurationError } from './config.ts'
import type { AppEnv } from './middleware/authorize.ts'
import { errorHandler, notFoundHandler } from './middleware/errors.ts'
import { adminRoutes } from './routes/admin.ts'
import { meRoutes } from './routes/me.ts'
import { posterRoutes } from './routes/posters.ts'
import { revisionRoutes } from './routes/revisions.ts'
import { projectRoutes, runRoutes, workspaceRoutes } from './routes/runs.ts'

export { PosterRendererContainer } from './container/poster-renderer.ts'

const app = new Hono<AppEnv>()

app.onError(errorHandler)
app.notFound(notFoundHandler)

/**
 * Better Auth owns its prefix entirely — session cookies, sign-out, and every endpoint the passkey
 * plugin adds. Mounting it as a catch-all rather than enumerating its routes means an endpoint the
 * framework adds in an update does not silently 404.
 */
app.all('/api/auth/*', async (context) => {
  return getAuth(context.env).handler(context.req.raw)
})

const v1 = new Hono<AppEnv>()

v1.route('/me', meRoutes)
v1.route('/runs', runRoutes)
v1.route('/projects', projectRoutes)
// The team gallery. Separate from /runs because it requires a capability /runs does not
// (`workspace:read`), and this router mounts capabilities as middleware so the route table stays
// the place where authorization can be read.
v1.route('/workspace', workspaceRoutes)
// Revision, snapshot and source-backup routes carry their own full paths (/runs/... and
// /revisions/...) because a snapshot belongs to a revision but is reached through its run.
v1.route('/', revisionRoutes)
v1.route('/', posterRoutes)
v1.route('/admin', adminRoutes)

app.route('/api/v1', v1)

/**
 * A Worker that starts without its secrets is a Worker that will do the wrong thing quietly — most
 * dangerously, run a passkey ceremony under an RP ID it invented. Configuration errors are caught
 * at the edge and answered as INTERNAL, with the real reason logged for an operator; the
 * alternative, a default RP ID derived from the request's Host header, is how every user's
 * credential gets invalidated at once.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx)
    } catch (error) {
      if (error instanceof ConfigurationError) {
        console.error(JSON.stringify({ configurationError: error.message }))
        return Response.json({ error: new ApiError('INTERNAL').toPayload() }, { status: 500 })
      }
      throw error
    }
  },
} satisfies ExportedHandler<Env>
