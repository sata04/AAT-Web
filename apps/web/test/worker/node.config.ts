/** Port-free fallback for SQL/handler regressions; workerd remains the deployment-runtime suite. */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:test': fileURLToPath(new URL('./helpers/node-runtime.ts', import.meta.url)),
      'cloudflare:workers': fileURLToPath(new URL('./helpers/node-durable-object.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/worker/**/*.spec.ts'],
    setupFiles: ['test/worker/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    restoreMocks: true,
  },
})
