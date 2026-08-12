/// <reference path="../../worker-configuration.d.ts" />

/**
 * The Drizzle handle over D1.
 *
 * One handle per `env`, cached: constructing it is cheap but not free, and an isolate serves many
 * requests with the same bindings. The full schema is attached so Better Auth's Drizzle adapter
 * can resolve its models by name (`schema.user`, `schema.session`, ...) and so relational queries
 * are typed.
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1'
import * as schema from './schema.ts'

export type Database = DrizzleD1Database<typeof schema>

const CLIENT_CACHE = new WeakMap<Env, Database>()

export function getDatabase(env: Env): Database {
  const cached = CLIENT_CACHE.get(env)
  if (cached) return cached
  const db = drizzle(env.DB, { schema })
  CLIENT_CACHE.set(env, db)
  return db
}

/**
 * Rows affected by the last write, normalised out of D1's result envelope.
 *
 * This is the return value the race-safe paths in this Worker are built on: a conditional
 * `UPDATE ... WHERE <the whole precondition>` that reports 1 is proof that *this* caller, and no
 * other, made the transition. Reading it is what replaces the SELECT-then-UPDATE pattern that
 * loses under concurrency.
 */
export function rowsAffected(result: D1Result): number {
  return result.meta.changes ?? 0
}
