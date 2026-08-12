/**
 * Worker test configuration.
 *
 * These tests run inside workerd against a real local D1 with the committed migrations applied —
 * not against a mock. That is the point: the invitation race, the quota reservation and the
 * automatic-poster uniqueness constraint are all properties of SQLite statements, and a fake
 * database would test the fake instead of the guarantee.
 *
 * Two deliberate departures from `wrangler.jsonc`:
 *
 *  - **Bindings are declared here rather than read from wrangler.jsonc.** The production config
 *    declares a container image that Miniflare cannot pull, so pointing the pool at it would make
 *    every test depend on a container registry.
 *  - **POSTER_RENDERER is bound to a stub Durable Object in an auxiliary worker.** The Worker code
 *    under test is unchanged — it still talks to a `DurableObjectNamespace` exactly as it does in
 *    production — but the object on the other end returns a fixed PNG and counts how many times it
 *    was asked to render. That counter is what makes "a second call does not re-render" an
 *    assertion about behaviour rather than about a status field.
 *
 * Test files are named `*.spec.ts` rather than `*.test.ts` so that the app's own Vitest project
 * (apps/web/vitest.config.ts, which runs the export suite under Node) does not try to run
 * Workers-runtime tests in a Node environment. Run these with:
 *
 *     pnpm --filter @aat/web exec vitest run --config test/worker/vitest.config.ts
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '../..')
const migrations = await readD1Migrations(path.join(appRoot, 'migrations'))

/**
 * The stub renderer. Mirrors the container's HTTP contract (poster-renderer/src/poster_renderer):
 * `GET /health` answers when it is up, `POST /render` returns a PNG with the renderer version
 * header. `/count` is the test-only introspection hook and is never called by the Worker.
 */
const posterRendererStub = /* javascript */ `
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ])

  export class FakePosterRenderer {
    constructor(state) {
      this.state = state
    }

    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/health') {
        return Response.json({ status: 'ok' })
      }
      if (url.pathname === '/count') {
        return Response.json({ count: (await this.state.storage.get('count')) ?? 0 })
      }
      if (url.pathname === '/fail') {
        await this.state.storage.put('fail', true)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/render') {
        await request.arrayBuffer()
        const count = ((await this.state.storage.get('count')) ?? 0) + 1
        await this.state.storage.put('count', count)
        if (await this.state.storage.get('fail')) {
          return new Response(JSON.stringify({ code: 'POSTER_RENDER_FAILED' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(PNG, {
          headers: {
            'content-type': 'image/png',
            'x-poster-renderer-version': 'aat-poster-renderer/test',
            'x-poster-preset-version': 'aat-poster-v1',
          },
        })
      }
      return new Response('not found', { status: 404 })
    }
  }

  export default { fetch: () => new Response('poster renderer stub') }
`

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: path.join(appRoot, 'worker/index.ts'),
      miniflare: {
        compatibilityDate: '2026-07-30',
        // Same flags as wrangler.jsonc: the tests must run the Worker in the shape it deploys in.
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'aat-test-db' },
        r2Buckets: ['AAT_OBJECTS'],
        durableObjects: {
          POSTER_RENDERER: { className: 'FakePosterRenderer', scriptName: 'poster-renderer-stub' },
        },
        bindings: {
          TEST_MIGRATIONS: migrations,
          // A test secret, and only ever a test secret.
          BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-else-0123456789',
          BETTER_AUTH_URL: 'https://aat.test',
          AAT_RP_ID: 'aat.test',
          AAT_RP_NAME: 'AAT Test',
          AAT_TRUSTED_ORIGINS: 'https://aat.test',
          AAT_DEFAULT_QUOTA_BYTES: '1048576',
          AAT_MAX_SNAPSHOT_BYTES: '262144',
          AAT_MAX_SOURCE_BYTES: '262144',
          AAT_MAX_POSTER_BYTES: '65536',
          AAT_MAX_CONCURRENT_RENDERS: '1',
          AAT_RENDER_STALE_SECONDS: '300',
          AAT_RESERVATION_TTL_SECONDS: '900',
        },
        workers: [
          {
            name: 'poster-renderer-stub',
            modules: true,
            script: posterRendererStub,
            compatibilityDate: '2026-07-30',
            durableObjects: { SELF_RENDERER: { className: 'FakePosterRenderer' } },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['**/*.spec.ts'],
    setupFiles: [path.join(here, 'setup.ts')],
    // The invitation race and the quota race run several requests at once; a generous timeout
    // keeps a slow CI machine from turning a passing race into a flake.
    testTimeout: 30_000,
  },
})
