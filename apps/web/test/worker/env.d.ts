/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference path="../../worker-configuration.d.ts" />

/**
 * Test-only bindings.
 *
 * `TEST_MIGRATIONS` is injected by test/worker/vitest.config.ts (read from apps/web/migrations by
 * `readD1Migrations`) and consumed by setup.ts. It exists only in the test environment; the
 * production `Env` in worker-configuration.d.ts has no such binding.
 */

import type { D1Migration } from '@cloudflare/vitest-pool-workers'

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
