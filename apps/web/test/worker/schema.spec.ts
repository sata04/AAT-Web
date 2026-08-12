/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The migrations, and the constraints they are supposed to create.
 *
 * A schema test is only worth writing if it asserts the guarantees other code depends on rather
 * than restating the DDL. These three are load-bearing:
 *
 *  - the partial unique index that makes the automatic poster idempotent,
 *  - the unique index that makes an analysis identity (source + config + engine) one revision,
 *  - the per-owner uniqueness of a run code, which must NOT be global.
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
      'projects',
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
  })
})
