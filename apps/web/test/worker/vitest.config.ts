/**
 * Worker test configuration.
 *
 * These tests run inside workerd against a real local D1 with the committed migrations applied —
 * not against a mock. That is the point: the invitation race, the quota reservation and the
 * automatic-poster uniqueness constraint are all properties of SQLite statements, and a fake
 * database would test the fake instead of the guarantee.
 *
 * Bindings are declared here rather than read from wrangler.jsonc: the test values are
 * deliberately small (a 64 KiB poster cap, a 1 MiB default quota) and the secrets are test-only
 * strings, so the suite exercises the Worker in the shape it deploys in without depending on
 * deploy values or real credentials.
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
        bindings: {
          TEST_MIGRATIONS: migrations,
          // A test secret, and only ever a test secret.
          BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-else-0123456789',
          BETTER_AUTH_URL: 'https://aat.test',
          AAT_RP_ID: 'aat.test',
          AAT_RP_NAME: 'AAT Test',
          AAT_TRUSTED_ORIGINS: 'https://aat.test',
          AAT_CLOUD_ENABLED: 'true',
          AAT_DEFAULT_QUOTA_BYTES: '1048576',
          AAT_MAX_SNAPSHOT_BYTES: '262144',
          AAT_MAX_SOURCE_BYTES: '262144',
          AAT_MAX_POSTER_BYTES: '65536',
          AAT_RESERVATION_TTL_SECONDS: '900',
        },
      },
    }),
  ],
  test: {
    // Anchored to this directory, not `**`. The pattern is resolved against the project root
    // (apps/web), so a bare `**/*.spec.ts` also matches `e2e/specs/*.spec.ts` — Playwright specs,
    // which import @playwright/test and cannot even be imported inside workerd. `.spec.ts` is the
    // right suffix for both suites; what distinguishes them is where they live, so the glob says so.
    include: ['test/worker/**/*.spec.ts'],
    setupFiles: [path.join(here, 'setup.ts')],
    // The invitation race and the quota race run several requests at once; a generous timeout
    // keeps a slow CI machine from turning a passing race into a flake.
    testTimeout: 30_000,
  },
})
