/**
 * The committed D1 migrations, applied to a database that has data in it.
 *
 * The workerd suite (`test/worker/`) already applies every migration before it runs, and that is
 * the "migrations apply cleanly from nothing" guarantee. It is not the guarantee this file is
 * about, and the difference is the reason this file exists: **that database is empty.** A migration
 * that rebuilds a table and loses every row of five others applies perfectly cleanly to an empty
 * database. It passes the whole workerd suite. It destroys the deployment.
 *
 * That is not hypothetical. Migration 0003 removes `runs.project_id`, which SQLite will not let go
 * of with `ALTER TABLE ... DROP COLUMN` because the column is named in a foreign key, so the table
 * has to be rebuilt. Step one of SQLite's own table-rebuild procedure is `PRAGMA foreign_keys=OFF`
 * — and D1 does not support it: enforcement there is permanently on, and `defer_foreign_keys`
 * defers constraint *violations* without suppressing referential *actions*. So `DROP TABLE runs`
 * on D1 fires ON DELETE CASCADE into `analysis_revisions` (and through it `analysis_metrics`,
 * `cloud_objects` and `poster_figures`) and into `run_tags` and `cloud_objects` directly. That is
 * every analysis ever recorded plus the only index of what is stored in R2.
 *
 * So the migrations are run here against `node:sqlite` with `PRAGMA foreign_keys=ON`, which is
 * exactly the mode D1 runs in, over a database seeded with one row in every table the cascade would
 * reach. The assertion is that the rows are still there afterwards.
 *
 * This is a test of the SQL files on disk, not of `worker/db/schema.ts`. It reads them, splits them
 * on drizzle's statement breakpoints and executes them in order — the same thing
 * `wrangler d1 migrations apply` does — so a future migration that reintroduces the hazard fails
 * here rather than in production.
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations')

/** Every committed migration, in the order `wrangler d1 migrations apply` would run them. */
function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function applyMigration(db: DatabaseSync, file: string): void {
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (trimmed !== '') db.exec(trimmed)
  }
}

/**
 * Insert one row, filling in whatever the table demands.
 *
 * Columns named in `overrides` get the given value; every other NOT NULL column gets a placeholder
 * of the right affinity and everything else gets NULL. The point of these rows is that they exist
 * and are correctly parented — nothing here asserts anything about their contents, so hand-writing
 * fourteen columns of realistic metrics would be effort spent on the part that does not matter.
 */
function seed(db: DatabaseSync, table: string, overrides: Record<string, string>): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string
    type: string
    notnull: number
  }[]
  const names = columns.map((column) => `"${column.name}"`).join(',')
  const values = columns
    .map((column) => {
      const override = overrides[column.name]
      if (override !== undefined) return `'${override}'`
      if (column.notnull === 0) return 'NULL'
      return /INT|REAL/i.test(column.type) ? '0' : "'x'"
    })
    .join(',')
  db.exec(`INSERT INTO ${table} (${names}) VALUES (${values})`)
}

/** Migrations 0000 up to but not including `stopBefore`, with foreign keys enforced as D1 does. */
function databaseBefore(stopBefore: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const file of migrationFiles()) {
    if (file === stopBefore) return db
    applyMigration(db, file)
  }
  throw new Error(`${stopBefore} is not a committed migration`)
}

const CASCADE_REACHES = [
  'runs',
  'run_tags',
  'analysis_revisions',
  'analysis_metrics',
  'cloud_objects',
  'poster_figures',
] as const

function rowCounts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    CASCADE_REACHES.map((table) => [
      table,
      (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c,
    ]),
  )
}

describe('the committed migrations', () => {
  it('apply in order from an empty database', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    for (const file of migrationFiles()) applyMigration(db, file)
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((row) => row.name)
    expect(tables).toContain('runs')
    expect(tables).toContain('run_tags')
  })

  it('leave no scratch table behind', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys=ON')
    for (const file of migrationFiles()) applyMigration(db, file)
    // The rebuild procedure creates `__new_runs` and five `__keep_*` copies. Every one of them is a
    // table with no foreign keys and no indexes; one left behind would be invisible to the
    // application and permanent in the database.
    const scratch = db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%' ESCAPE '\\'")
      .all() as { name: string }[]
    expect(scratch).toEqual([])
  })
})

describe('0003_drop_projects, applied to a database with data in it', () => {
  function seeded(): DatabaseSync {
    const db = databaseBefore('0003_drop_projects.sql')
    seed(db, 'user', { id: 'u1', name: '田中', email: 'u1@aat.invalid', role: 'Researcher' })
    seed(db, 'projects', { id: 'p1', owner_user_id: 'u1', name: '微小重力2026' })
    seed(db, 'runs', {
      id: 'r1',
      owner_user_id: 'u1',
      project_id: 'p1',
      run_code: '260811a',
      experiment_date: '2026-08-11',
      suffix: 'a',
      original_filename: '260811a_data.csv',
      memo: '再測定',
    })
    seed(db, 'run_tags', { run_id: 'r1', tag: '再測定' })
    seed(db, 'analysis_revisions', { id: 'v1', run_id: 'r1', owner_user_id: 'u1' })
    seed(db, 'analysis_metrics', { id: 'm1', analysis_revision_id: 'v1' })
    seed(db, 'cloud_objects', { id: 'o1', run_id: 'r1', analysis_revision_id: 'v1', owner_user_id: 'u1' })
    seed(db, 'poster_figures', { id: 'f1', analysis_revision_id: 'v1', owner_user_id: 'u1' })
    return db
  }

  it('loses not one row of the research record', () => {
    const db = seeded()
    const before = rowCounts(db)
    // Every table the cascade would reach must actually have a row, or this test proves nothing.
    for (const [table, count] of Object.entries(before)) expect(count, table).toBe(1)

    applyMigration(db, '0003_drop_projects.sql')

    expect(rowCounts(db)).toEqual(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('carries the run across unchanged apart from the column it removes', () => {
    const db = seeded()
    applyMigration(db, '0003_drop_projects.sql')

    const run = db.prepare("SELECT * FROM runs WHERE id = 'r1'").get() as Record<string, unknown>
    expect(run.run_code).toBe('260811a')
    expect(run.experiment_date).toBe('2026-08-11')
    expect(run.suffix).toBe('a')
    expect(run.original_filename).toBe('260811a_data.csv')
    expect(run.memo).toBe('再測定')
    expect('project_id' in run).toBe(false)
  })

  it('drops the projects table', () => {
    const db = seeded()
    applyMigration(db, '0003_drop_projects.sql')
    const found = db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all()
    expect(found).toEqual([])
  })

  it('leaves a runs table that can still be written to', () => {
    // The reason `projects` could not simply be dropped on its own: while `runs.project_id` still
    // carried a foreign key to it, the next INSERT failed with "no such table: main.projects" —
    // run creation would have broken for every user in the deployment.
    const db = seeded()
    applyMigration(db, '0003_drop_projects.sql')
    db.exec(
      "INSERT INTO runs (id,owner_user_id,run_code,original_filename,created_at,updated_at) VALUES ('r2','u1','260812a','260812a_data.csv',0,0)",
    )
    expect((db.prepare('SELECT COUNT(*) c FROM runs').get() as { c: number }).c).toBe(2)
  })

  it("keeps the run listing's indexes, which the rebuild would otherwise have dropped with the table", () => {
    const db = seeded()
    applyMigration(db, '0003_drop_projects.sql')
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string }[]
    ).map((row) => row.name)
    // Per-owner run-code uniqueness in particular: losing it would let one researcher record the
    // same experiment twice, which `POST /runs` relies on the database to refuse.
    expect(indexes).toContain('runs_owner_run_code_unique')
    expect(indexes).toContain('runs_owner_experiment_date_idx')
    expect(indexes).toContain('runs_owner_created_at_idx')
  })

  it('never turns foreign keys off, because D1 does not allow it', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '0003_drop_projects.sql'), 'utf8')
    // `PRAGMA foreign_keys=OFF` is what drizzle-kit generates for a table rebuild and what D1
    // rejects. Asserted against the file rather than against behaviour: `node:sqlite` would honour
    // it happily, so nothing else in this suite could notice it coming back.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/PRAGMA\s+foreign_keys/i)
  })
})
