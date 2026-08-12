/// <reference path="../../worker-configuration.d.ts" />

/**
 * The Durable Object that owns the poster renderer container.
 *
 * The container is a Python service (see `poster-renderer/`) that listens on port 8080 and exposes
 * `GET /health` and `POST /render`. It does no analysis: it receives numbers the browser already
 * computed and draws them. This class is the only thing that talks to it.
 *
 * ## Cost control lives here
 *
 * A container that stays warm is a container that is billed. AAT renders on the order of one
 * poster per analysis — a researcher might produce a handful in a day — so the correct steady
 * state is "not running". Two mechanisms keep it there, and both are cost guards rather than
 * performance tuning (see docs/cost-controls.md):
 *
 *  - {@link POSTER_RENDERER_SLEEP_AFTER_MS}, enforced with a Durable Object alarm: once a render
 *    finishes, the container is destroyed after a short idle period. This is the `sleepAfter` the
 *    task asks for; it lives in code rather than in wrangler.jsonc because Wrangler's container
 *    schema has no such field — it is a property of the `Container` class in
 *    `@cloudflare/containers`, which this project deliberately does not depend on (one fewer
 *    package on a path that can spend money).
 *  - `"max_instances": 1` in wrangler.jsonc, which caps how many can exist at once.
 *
 * ## Cold starts are expected, not an error
 *
 * Starting a Python + Matplotlib container takes seconds. `renderPoster` waits for the health
 * endpoint to answer rather than assuming readiness, and the caller treats a timeout as
 * POSTER_BUSY — backpressure — rather than as a failed render.
 */

import { DurableObject } from 'cloudflare:workers'

/** The port the Python renderer listens on (poster-renderer/src/poster_renderer/config.py). */
const CONTAINER_PORT = 8080

/**
 * Idle time before the container is torn down. Deliberately short: a warm container between the
 * two posters someone generates in an afternoon costs an afternoon of compute.
 */
export const POSTER_RENDERER_SLEEP_AFTER_MS = 60_000

/** How long to wait for a cold container to answer /health before giving up and shedding load. */
const STARTUP_TIMEOUT_MS = 45_000

/** Poll interval while waiting for the container to become healthy. */
const HEALTH_POLL_INTERVAL_MS = 500

/** Ceiling on one render, independent of the container's own timeout. */
const RENDER_TIMEOUT_MS = 60_000

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export class PosterRendererContainer extends DurableObject<Env> {
  /**
   * Proxy one request to the container, starting it if necessary.
   *
   * Only `/render` and `/health` are forwarded. The Durable Object is not a general-purpose proxy:
   * anything else is refused here rather than handed to the container to reject, so a mistake in
   * the calling code cannot turn this into an open path into the container's network namespace.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/render' && url.pathname !== '/health') {
      return new Response('not found', { status: 404 })
    }

    const container = this.ctx.container
    if (!container) {
      // No container binding at runtime — the deployment is misconfigured, or this is a test
      // environment without container support. Either way the caller must not retry forever.
      return new Response(JSON.stringify({ code: 'POSTER_RENDERER_UNAVAILABLE' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (!container.running) {
      // enableInternet: false — the renderer takes its input in the request body and needs no
      // outbound network. Denying it one removes exfiltration as a possibility rather than as a
      // policy.
      container.start({ enableInternet: false })
    }

    const ready = await this.waitForHealth(container)
    if (!ready) {
      return new Response(JSON.stringify({ code: 'POSTER_BUSY' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    }

    // Reschedule the teardown alarm on every request, so a burst of renders keeps the container
    // alive and an idle one goes away.
    await this.ctx.storage.setAlarm(Date.now() + POSTER_RENDERER_SLEEP_AFTER_MS)

    const port = container.getTcpPort(CONTAINER_PORT)
    const timeout = AbortSignal.timeout(RENDER_TIMEOUT_MS)
    try {
      return await port.fetch(
        new Request(`http://container${url.pathname}`, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: timeout,
        }),
      )
    } catch (error) {
      return new Response(
        JSON.stringify({ code: 'POSTER_RENDER_FAILED', reason: (error as Error).name }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  private async waitForHealth(container: Container): Promise<boolean> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const port = container.getTcpPort(CONTAINER_PORT)
    for (;;) {
      try {
        const response = await port.fetch('http://container/health', {
          signal: AbortSignal.timeout(HEALTH_POLL_INTERVAL_MS * 4),
        })
        if (response.ok) {
          // The body must be consumed or the connection is held open.
          await response.arrayBuffer()
          return true
        }
      } catch {
        // Not up yet. A connection refused during startup is the normal case, not an error.
      }
      if (Date.now() >= deadline) return false
      await sleep(HEALTH_POLL_INTERVAL_MS)
    }
  }

  /** The teardown. Fires once the container has been idle for {@link POSTER_RENDERER_SLEEP_AFTER_MS}. */
  override async alarm(): Promise<void> {
    const container = this.ctx.container
    if (container?.running) {
      await container.destroy()
    }
  }
}
