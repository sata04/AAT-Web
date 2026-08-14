/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The migrations, and the constraints they are supposed to create.
 *
 * A schema test is only worth writing if it asserts the guarantees other code depends on rather
 * than restating the DDL. These are load-bearing:
 *
 *  - the partial unique index that makes the automatic poster idempotent,
 *  - the unique index that makes an analysis identity (source + config + engine) one revision,
 *  - the per-owner uniqueness of a run code, which must NOT be global,
 *  - the shape of `passkey`, which is not AAT's to choose: `@better-auth/passkey` writes it
 *    through Better Auth's adapter and a column the plugin does not know about is a failed INSERT
 *    on the first registration after a deploy.
 */

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

async function tableNames(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>()
  return result.results.map((row) => row.name)
}

describe('migrations', () => {
  it('create every table the Worker depends on', async () => {
    const names = await tableNames()
    for (const expected of [
      'user',
      'session',
      'account',
      'verification',
      'passkey',
      'registration_invites',
      'runs',
      'run_tags',
      'analysis_revisions',
      'analysis_metrics',
      'poster_presets',
      'poster_figures',
      'cloud_objects',
      'quota_usage',
      'quota_reservations',
      'audit_logs',
      'system_flags',
      'rate_limits',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('leave no trace of the projects entity', async () => {
    // Removed by 0003. Asserted rather than merely absent from the list above, because the failure
    // mode being guarded is the table surviving the migration while nothing queries it — a grouping
    // that exists in the database and in no code is exactly the half-finished state 0003 resolved.
    expect(await tableNames()).not.toContain('projects')

    const runColumns = await env.DB.prepare('PRAGMA table_info(runs)').all<{ name: string }>()
    expect(runColumns.results.map((row) => row.name)).not.toContain('project_id')
  })

  it('record themselves as applied, so a second run is a no-op', async () => {
    const applied = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()
    expect(applied.results.length).toBeGreaterThan(0)
  })

  it('store no time-series samples in D1', async () => {
    // The architecture forbids a sample-per-row table. If one ever appears, this is where it is
    // noticed — the smell is a table whose name suggests samples, points or series.
    const names = await tableNames()
    for (const name of names) {
      expect(name).not.toMatch(/sample|datapoint|series|waveform/i)
    }
  })
})

describe('the passkey table', () => {
  async function columns(table: string): Promise<Map<string, { notnull: number; dflt_value: unknown }>> {
    const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
      name: string
      notnull: number
      dflt_value: unknown
    }>()
    return new Map(
      result.results.map((row) => [row.name, { notnull: row.notnull, dflt_value: row.dflt_value }]),
    )
  }

  it("carries every column the plugin's model writes", async () => {
    const passkey = await columns('passkey')
    // The plugin's schema, field by field. Anything missing here is an INSERT that fails on the
    // first real registration rather than in a test.
    for (const column of [
      'id',
      'name',
      'public_key',
      'user_id',
      'credential_id',
      'counter',
      'device_type',
      'backed_up',
      'transports',
      'aaguid',
      'created_at',
    ]) {
      expect(passkey.has(column)).toBe(true)
    }
  })

  it('has no column the plugin does not write and cannot default', async () => {
    const passkey = await columns('passkey')
    // `algorithm` was part of the hand-written implementation and was NOT NULL with no default.
    // The plugin never sets it, so leaving it behind would fail every registration.
    expect(passkey.has('algorithm')).toBe(false)

    // AAT's own additions must be nullable for exactly the same reason: the adapter only writes
    // fields the plugin declares, so anything else has to be satisfiable by omission.
    const pluginFields = new Set([
      'id',
      'name',
      'public_key',
      'user_id',
      'credential_id',
      'counter',
      'device_type',
      'backed_up',
      'transports',
      'aaguid',
      'created_at',
    ])
    for (const [name, column] of passkey) {
      if (pluginFields.has(name)) continue
      expect(column.notnull === 0 || column.dflt_value !== null).toBe(true)
    }
  })

  it('refuses to let one credential belong to two accounts', async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'passkey_credential_id_unique'",
    ).first<{ sql: string }>()
    expect(index?.sql).toContain('UNIQUE')
    expect(index?.sql).toContain('credential_id')
  })
})

describe('uniqueness constraints', () => {
  it('allow exactly one automatic poster per (revision, preset version)', async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'poster_figures_auto_unique'",
    ).first<{ sql: string }>()
    expect(index?.sql).toContain('UNIQUE')
    // The partial predicate is the whole point: custom posters must not be constrained.
    expect(index?.sql).toContain("kind = 'auto'")
  })

  it('make an analysis identity unique per run', async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'revisions_run_identity_unique'",
    ).first<{ sql: string }>()
    expect(index?.sql).toContain('UNIQUE')
    expect(index?.sql).toContain('source_sha256')
    expect(index?.sql).toContain('config_hash')
    expect(index?.sql).toContain('engine_version')
  })

  it('scope run-code uniqueness to the owner, not globally', async () => {
    const index = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_owner_run_code_unique'",
    ).first<{ sql: string }>()
    // Two researchers each having a run 260811a is normal; a global constraint would stop the
    // second one from recording their own experiment.
    expect(index?.sql).toContain('owner_user_id')
    expect(index?.sql).toContain('run_code')
    // ...and to LIVE runs. A run is deleted by stamping `deleted_at` and keeping the row, so
    // without this predicate a tombstone reserves its run code forever and the experiment can
    // never be synced again — there is no endpoint that clears `deleted_at`. Migration 0004.
    expect(index?.sql?.replace(/\s+/g, ' ')).toMatch(/WHERE deleted_at IS NULL/i)
  })
})
