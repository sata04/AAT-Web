/**
 * Starts the stack once for the whole run and hands its coordinates to the test workers.
 *
 * Playwright forks its workers after this file resolves, so `process.env` is how the base URL, the
 * harness token and the renderer's availability reach them — no state file, and nothing that can be
 * left behind by a crashed run.
 *
 * The returned function is Playwright's global teardown.
 */

import { startStack } from './stack.ts'

export default async function globalSetup(): Promise<() => Promise<void>> {
  const stack = await startStack()

  process.env.AAT_E2E_BASE_URL = stack.baseUrl
  process.env.AAT_E2E_HARNESS_TOKEN = stack.harnessToken
  process.env.AAT_E2E_RENDERER = stack.rendererAvailable ? '1' : '0'

  return async () => {
    await stack.stop()
  }
}
