/**
 * The suite's fixtures.
 *
 * Three additions to Playwright's own:
 *
 *  - `harness` — the local D1, for the bootstrap invitation and for the assertions that are about
 *    a database constraint rather than about a rendered status. See `database.ts`.
 *  - `authenticator` — a Chromium virtual authenticator attached to the test's page, created
 *    lazily so a test that never touches authentication never pays for one.
 *  - a per-test reset of the rate-limit counters, for the reason given in `Harness.resetRateLimits`.
 *
 * `rendererAvailable` is exported rather than fixtured because it is decided once, in global setup,
 * and `test.skip` needs it at collection time.
 */

import { test as base, expect } from '@playwright/test'
import { type Harness, harnessFromEnvironment } from './database.ts'
import { addVirtualAuthenticator, type VirtualAuthenticator } from './webauthn.ts'

export interface AatFixtures {
  harness: Harness
  authenticator: VirtualAuthenticator
}

export const test = base.extend<AatFixtures>({
  // Playwright reads this parameter's destructuring pattern to work out which fixtures are wanted,
  // and rejects anything that is not an object pattern — even when the answer is "none".
  // biome-ignore lint/correctness/noEmptyPattern: required by Playwright's fixture parameter parser
  harness: async ({}, use) => {
    const harness = harnessFromEnvironment()
    await harness.resetRateLimits()
    await use(harness)
  },

  authenticator: async ({ page }, use) => {
    const authenticator = await addVirtualAuthenticator(page)
    await use(authenticator)
  },
})

export { expect }

/** Did global setup manage to start the real poster renderer container? */
export const rendererAvailable = process.env.AAT_E2E_RENDERER === '1'
