/** Exercise the real routes with swappable D1/R2 bindings, without starting a listener. */
import { Hono } from 'hono'
import type { AppEnv } from '../../../worker/middleware/authorize.ts'
import { errorHandler } from '../../../worker/middleware/errors.ts'
import { revisionRoutes } from '../../../worker/routes/revisions.ts'
import { runRoutes } from '../../../worker/routes/runs.ts'

export function storageApp() {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler)
  app.route('/api/v1/runs', runRoutes)
  app.route('/api/v1', revisionRoutes)
  return app
}
