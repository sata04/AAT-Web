/**
 * Direct access to the local D1, and the bootstrap invitation built on top of it.
 *
 * ## Why a SQL endpoint rather than `wrangler d1 execute`
 *
 * `wrangler dev` holds the local SQLite file open for the length of the run. A second Wrangler
 * process writing to it concurrently is a lock fight waiting to happen, and a suite that
 * occasionally deadlocks on its own fixtures is worse than no suite. So the SQL goes through the
 * Worker that already owns the binding — see `e2e/worker/entry.ts` — which is the same database,
 * the same statements, and no second writer.
 *
 * ## Why the tests reach into the database at all
 *
 * Two reasons, and only these two:
 *
 *  - **The bootstrap invitation.** `docs/deployment.md` is explicit that a fresh deployment has no
 *    administrator and no HTTP path to create one: the first invitation is inserted straight into
 *    D1 by whoever holds the credentials, with `created_by_user_id` NULL. {@link createInvitation}
 *    below is that procedure, automated — generate 32 random bytes, store only the SHA-256, keep
 *    the plaintext in memory for the one redemption it authorises.
 *  - **Assertions the API deliberately does not expose.** "Exactly one automatic poster exists for
 *    this revision" is a uniqueness constraint in SQLite, and reading the rows back is the only way
 *    to assert on the constraint rather than on a status field that happens to agree with it.
 *
 * Everything else in the suite goes through the browser.
 */

import { createHash, randomBytes } from 'node:crypto'
import { ulid } from 'ulid'

export interface SqlResult<Row> {
  results: Row[]
  meta: Record<string, unknown>
}

export class Harness {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async sql<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> {
    const response = await fetch(`${this.baseUrl}/__e2e__/sql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-e2e-token': this.token },
      body: JSON.stringify({ sql, params }),
    })
    if (!response.ok) {
      throw new Error(`harness SQL failed (${response.status}): ${await response.text()}\n${sql}`)
    }
    const body = (await response.json()) as SqlResult<Row>
    return body.results
  }

  async one<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row | null> {
    const rows = await this.sql<Row>(sql, params)
    return rows[0] ?? null
  }

  /**
   * Clear the fixed-window rate-limit counters.
   *
   * The credential endpoints allow ten attempts a minute per address, and every request in this
   * suite arrives from the same loopback address. Without this, the eleventh registration in a
   * minute would fail with `RATE_LIMITED` for reasons that have nothing to do with what it was
   * asserting. The limiter itself is exercised deliberately in `test/worker/rate-limit.spec.ts`,
   * which is where it belongs — a browser cannot observe a counter.
   */
  async resetRateLimits(): Promise<void> {
    await this.sql('DELETE FROM rate_limits')
  }

  /**
   * Issue an invitation the way a fresh deployment's first one is issued.
   *
   * The plaintext token is returned and is the only copy that will ever exist: the row stores the
   * SHA-256 alone, exactly as `worker/auth/invitations.ts` does when an administrator issues one
   * through the console.
   *
   * `created_at` / `expires_at` are epoch **seconds**, because `worker/db/schema.ts` declares them
   * `integer('...', { mode: 'timestamp' })` and Drizzle's `timestamp` mode is seconds. (The example
   * in docs/deployment.md writes milliseconds; see the note in the suite's report.)
   */
  async createInvitation(
    options: {
      role?: 'Admin' | 'Researcher' | 'Viewer'
      displayName?: string
      kind?: 'registration' | 'recovery'
      targetUserId?: string
      createdByUserId?: string | null
      ttlSeconds?: number
    } = {},
  ): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const id = ulid()
    const now = Math.floor(Date.now() / 1000)
    const ttl = options.ttlSeconds ?? 3600

    await this.sql(
      `INSERT INTO registration_invites
         (id, token_hash, kind, role, display_name, target_user_id, created_by_user_id,
          created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        id,
        tokenHash,
        options.kind ?? 'registration',
        options.role ?? 'Researcher',
        options.displayName ?? 'E2E 研究者',
        options.targetUserId ?? null,
        options.createdByUserId ?? null,
        now,
        now + ttl,
      ],
    )

    return { id, token }
  }

  /** The most recent audit entries for an action, newest first. */
  auditEntries(action: string, limit = 20) {
    return this.sql<{ id: string; action: string; actor_user_id: string | null; target_id: string | null }>(
      'SELECT id, action, actor_user_id, target_id FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT ?',
      [action, limit],
    )
  }
}

export function harnessFromEnvironment(): Harness {
  const baseUrl = process.env.AAT_E2E_BASE_URL
  const token = process.env.AAT_E2E_HARNESS_TOKEN
  if (baseUrl === undefined || token === undefined) {
    throw new Error('The e2e stack is not running: AAT_E2E_BASE_URL / AAT_E2E_HARNESS_TOKEN are unset.')
  }
  return new Harness(baseUrl, token)
}
