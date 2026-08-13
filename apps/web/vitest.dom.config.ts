/**
 * DOM component tests.
 *
 * A **separate** Vitest project from `vitest.config.ts`, deliberately, rather than a second
 * environment inside it. The Node suite in `test/ui/**` tests the pure modules — decimation,
 * ordering, the memo state machine, the poster spec builders — and it must keep running in a plain
 * Node environment, because those modules genuinely do not need a DOM and a jsdom global would only
 * hide an accidental `window` reference in code that is supposed to work inside a Web Worker.
 *
 * The split is enforced by the file extension as well as by the directory: the Node project matches
 * `test/**\/*.test.ts` and every file here is `.tsx`, so neither project can pick up the other's
 * tests even if a file moves.
 *
 * `@vitejs/plugin-react` is the same plugin `vite.config.ts` uses, so a component is compiled here
 * exactly as it is compiled for the browser — no second JSX pipeline that could disagree with the
 * shipped one.
 */

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'dom',
    include: ['test/dom/**/*.test.tsx'],
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        // A secure https origin, because `supportsWebAuthn()` refuses an insecure context before it
        // looks at anything else — and every authentication screen is behind that check.
        url: 'https://aat.test/',
      },
    },
    setupFiles: ['test/dom/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
    // Real timers by default; the memo autosave test opts into fake ones for its own file.
    testTimeout: 15_000,
  },
})
