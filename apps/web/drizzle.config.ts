/**
 * drizzle-kit configuration.
 *
 * Only `generate` is ever run against this: `pnpm --filter @aat/web db:generate` turns
 * worker/db/schema.ts into a numbered SQL file in migrations/, which is committed and reviewed
 * like any other code. Migrations are applied by `wrangler d1 migrations apply` — never by
 * drizzle-kit push, which would diff a live production database against local source and decide
 * on its own what to drop.
 *
 * `dialect: 'sqlite'` rather than a D1 driver on purpose: generation needs no credentials and no
 * network, so the one command a developer runs most often cannot touch the deployed database.
 */

import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './worker/db/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
})
