/**
 * End-to-end configuration.
 *
 * The suite runs against a real local stack — a Vite build served by Workers Static Assets, the
 * real Worker in `workerd`, a local D1 with the committed migrations applied, local R2, and the
 * pinned poster-renderer container under Docker. `e2e/harness/stack.ts` starts all of it; nothing
 * here reaches Cloudflare and nothing needs a credential the reader has to supply.
 *
 * ## One worker, no retries, on purpose
 *
 * Every test shares one Worker, one database and one renderer, so parallel workers would be tests
 * racing each other for the state they assert on. Isolation comes instead from each test creating
 * its own user and its own run code, which is cheap and — unlike a parallel run against shared
 * state — deterministic.
 *
 * `retries: 0` everywhere, including CI. A retried flake is a flake that stops being reported, and
 * this suite covers the paths where an intermittent failure is most likely to be a real bug: a
 * ceremony that did not complete, a poster that never settled, a revision that was written twice.
 *
 * The machine this was written on has four cores; a poster render and a `vite build` are both on
 * the critical path, so the per-test timeout is generous rather than tight.
 */

import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.AAT_E2E_BASE_URL ?? 'http://localhost:8788'

/**
 * Where Chromium is.
 *
 * Left to Playwright by default, which is right for CI and for a developer who ran
 * `playwright install`. `AAT_E2E_CHROMIUM_PATH` exists for a machine that already has a Chromium
 * of a different build number sitting somewhere — a sandbox with a pre-provisioned browser, most
 * often — where downloading another copy is neither possible nor useful.
 */
const chromiumPath = process.env.AAT_E2E_CHROMIUM_PATH

export default defineConfig({
  testDir: './e2e/specs',
  outputDir: './test-results',
  globalSetup: './e2e/harness/global-setup.ts',

  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI === 'true',

  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI === 'true' ? [['list'], ['github']] : [['list']],

  use: {
    baseURL,
    // Diagnostics for the one run that fails, and nothing for the ones that do not.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // A viewport wide enough for the analyzer's two-pane layout: the side panel carries the
        // statistics, the range readout and the poster controls, and a narrow viewport hides them.
        viewport: { width: 1440, height: 900 },
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
  ],
})
