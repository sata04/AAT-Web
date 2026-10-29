import { DurableObject } from 'cloudflare:workers'

/**
 * Compatibility export for the namespace created by migration v1.
 *
 * Existing deployments must keep exporting the class until its data can be deliberately retired.
 * There is no callable production binding, render/start path, or storage deletion. A legacy idle
 * alarm keeps its stop-only teardown so an already-running renderer cannot be stranded on cutover.
 */
export async function stopRetiredPosterContainer(
  container: Pick<Container, 'running' | 'destroy'> | undefined,
): Promise<void> {
  if (container?.running) await container.destroy()
}

export class PosterRendererContainer extends DurableObject<Env> {
  override fetch(): Response {
    return Response.json(
      { error: 'POSTER_RENDERER_RETIRED', message: 'Reload AAT Web to render posters in your browser.' },
      { status: 410, headers: { 'cache-control': 'no-store' } },
    )
  }

  override async alarm(): Promise<void> {
    // This stops only ephemeral compute, just as the old idle alarm did. DO/D1/R2 are untouched.
    await stopRetiredPosterContainer(this.ctx.container)
  }
}
