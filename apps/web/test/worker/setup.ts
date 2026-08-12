/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Applies the committed D1 migrations before any test runs.
 *
 * This is also the "migrations apply cleanly from an empty database" guarantee in its strongest
 * form: every test in this suite runs against a database built by the same SQL that production
 * runs, from nothing. A migration that does not apply fails the entire suite immediately, rather
 * than one test that everyone learns to skip.
 */

import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeEach } from 'vitest'

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

/**
 * Reset the rate-limit counters between tests.
 *
 * This pool version keeps one database for the whole run rather than isolating storage per test,
 * and the credential endpoints are deliberately limited to ~10 attempts a minute. Without this,
 * the sixth test in a file would fail with RATE_LIMITED for reasons that have nothing to do with
 * what it is asserting. The limiter itself is exercised deliberately in rate-limit.spec.ts, which
 * makes all of its requests inside a single test.
 */
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM rate_limits').run()
})
