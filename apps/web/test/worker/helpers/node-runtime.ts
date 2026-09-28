/**
 * Port-free test bindings. SQL runs against SQLite with real migrations and transactional D1
 * batches. R2 and the renderer implement only the contracts used by this suite; this does not
 * substitute for workerd's transport, isolation, or Durable Object scheduling checks.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

const sqlite = new DatabaseSync(':memory:')
sqlite.exec('PRAGMA foreign_keys = ON')

class Statement {
  constructor(
    readonly sql: string,
    readonly params: SQLInputValue[] = [],
  ) {}
  bind(...params: SQLInputValue[]): Statement {
    return new Statement(this.sql, params)
  }
  execute() {
    const results = sqlite.prepare(this.sql).all(...this.params)
    const meta = sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get()
    return { success: true, results, meta }
  }
  async all() {
    return this.execute()
  }
  async run() {
    return this.execute()
  }
  async raw() {
    const statement = sqlite.prepare(this.sql)
    statement.setReturnArrays(true)
    return statement.all(...this.params)
  }
  async first(column?: string) {
    const row = this.execute().results[0]
    return column ? (row?.[column] ?? null) : (row ?? null)
  }
}

const database = {
  prepare: (sql: string) => new Statement(sql),
  async batch(statements: Statement[]) {
    sqlite.exec('BEGIN')
    try {
      const results = statements.map((statement) => statement.execute())
      sqlite.exec('COMMIT')
      return results
    } catch (error) {
      sqlite.exec('ROLLBACK')
      throw error
    }
  },
  async exec(sql: string) {
    sqlite.exec(sql)
    return { count: 1, duration: 0 }
  },
}

export async function applyD1Migrations(): Promise<void> {
  sqlite.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY, name TEXT)')
  for (const name of readdirSync(new URL('../../../migrations/', import.meta.url)).sort()) {
    if (!name.endsWith('.sql')) continue
    sqlite.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'))
    sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
  }
}

interface StoredObject {
  bytes: ArrayBuffer
  metadata: R2PutOptions
  checksum: ArrayBuffer
}
const objects = new Map<string, StoredObject>()
function objectHead(key: string, stored: StoredObject) {
  return {
    key,
    size: stored.bytes.byteLength,
    checksums: { sha256: stored.checksum },
    httpMetadata: stored.metadata.httpMetadata ?? {},
    customMetadata: stored.metadata.customMetadata ?? {},
    httpEtag: '"test-etag"',
    uploaded: new Date(),
  }
}
const bucket = {
  async put(key: string, body: BodyInit, metadata: R2PutOptions = {}) {
    const bytes = await new Response(body).arrayBuffer()
    const stored = { bytes, metadata, checksum: await crypto.subtle.digest('SHA-256', bytes) }
    objects.set(key, stored)
    return objectHead(key, stored)
  },
  async get(key: string) {
    const stored = objects.get(key)
    if (!stored) return null
    return {
      ...objectHead(key, stored),
      body: new Response(stored.bytes).body,
      arrayBuffer: async () => stored.bytes.slice(0),
      text: async () => new TextDecoder().decode(stored.bytes),
    }
  },
  async head(key: string) {
    const stored = objects.get(key)
    return stored ? objectHead(key, stored) : null
  },
  async delete(keys: string | string[]) {
    for (const key of typeof keys === 'string' ? [keys] : keys) objects.delete(key)
  },
  async list(options: { prefix?: string } = {}) {
    return {
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ''))
        .map(([key, stored]) => objectHead(key, stored)),
      truncated: false,
      delimitedPrefixes: [],
    }
  },
}

let renderCount = 0
let renderFails = false
const renderer = {
  async fetch(input: string | Request) {
    const path = new URL(typeof input === 'string' ? input : input.url).pathname
    if (path === '/count') return Response.json({ count: renderCount })
    if (path === '/fail') {
      renderFails = true
      return Response.json({ ok: true })
    }
    if (path === '/health') return Response.json({ status: 'ok' })
    if (path !== '/render') return new Response(null, { status: 404 })
    renderCount++
    if (renderFails) return Response.json({ code: 'POSTER_RENDER_FAILED' }, { status: 500 })
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new Array<number>(64).fill(0)]), {
      headers: {
        'content-type': 'image/png',
        'x-poster-renderer-version': 'aat-poster-renderer/test',
        'x-poster-preset-version': 'aat-poster-v1',
      },
    })
  },
}

export const env = {
  DB: database,
  AAT_OBJECTS: bucket,
  POSTER_RENDERER: { idFromName: (name: string) => name, get: () => renderer },
  BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-else-0123456789',
  BETTER_AUTH_URL: 'https://aat.test',
  AAT_RP_ID: 'aat.test',
  AAT_RP_NAME: 'AAT Test',
  AAT_TRUSTED_ORIGINS: 'https://aat.test',
  AAT_DEFAULT_QUOTA_BYTES: '1048576',
  AAT_MAX_SNAPSHOT_BYTES: '262144',
  AAT_MAX_SOURCE_BYTES: '262144',
  AAT_MAX_POSTER_BYTES: '65536',
  AAT_MAX_CONCURRENT_RENDERS: '1',
  AAT_RENDER_STALE_SECONDS: '300',
  AAT_RESERVATION_TTL_SECONDS: '900',
} as unknown as Env

// Workers accept streamed bodies without Node's duplex option, including reconstructed requests.
const NativeRequest = globalThis.Request
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, { ...init, duplex: 'half' } as RequestInit)
  }
}

export function createExecutionContext(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
}

export const SELF = {
  async fetch(input: string | Request, init?: RequestInit) {
    const worker = (await import('../../../worker/index.ts')).default
    return worker.fetch(new Request(input, init), env, createExecutionContext())
  },
}
