/**
 * Fixed-window rate limiting in D1.
 *
 * One statement, no read-then-write: an `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`
 * either starts a new window or increments the current one, atomically, and tells the caller what
 * the count became. A SELECT followed by an UPDATE would let two concurrent requests both read
 * "4 of 5" and both proceed — which on the invitation-redemption path is precisely the case the
 * limit exists to stop.
 *
 * The window is fixed rather than sliding. A fixed window admits up to 2x the limit across a
 * window boundary; for the limits here (a handful of attempts per minute on credential paths) that
 * is an acceptable trade for a single round trip and no per-request state.
 */

import { sql } from 'drizzle-orm'
import { ApiError } from '@aat/shared'
import type { Database } from '../db/client.ts'
import { rateLimits } from '../db/schema.ts'

export interface RateLimitRule {
  /** Maximum permitted attempts within the window. */
  limit: number
  windowSeconds: number
}

/** Credential paths are the ones worth spending a database write on. */
export const RATE_LIMITS = {
  /** Redeeming an invitation token: a guessing attack's only entry point. */
  inviteRedeem: { limit: 10, windowSeconds: 60 },
  /** Completing a passkey registration against a claimed context. */
  passkeyRegister: { limit: 10, windowSeconds: 60 },
  /** Requesting an authentication challenge. */
  passkeyAuthenticate: { limit: 30, windowSeconds: 60 },
  /** Creating invitations, per admin. */
  inviteCreate: { limit: 30, windowSeconds: 60 },
  /** Poster renders, per user — the only endpoint that costs container time. */
  posterRender: { limit: 20, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>

/**
 * Count one attempt against `key`.
 *
 * Returns the remaining allowance; throws `RATE_LIMITED` once the window's limit is exceeded. The
 * attempt is counted either way, so a client that keeps hammering keeps its window open.
 */
export async function consumeRateLimit(
  db: Database,
  key: string,
  rule: RateLimitRule,
  now: Date = new Date(),
): Promise<number> {
  const nowSeconds = Math.floor(now.getTime() / 1000)
  const windowStartCutoff = nowSeconds - rule.windowSeconds

  const rows = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStart: nowSeconds })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStart} <= ${windowStartCutoff} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        windowStart: sql`CASE WHEN ${rateLimits.windowStart} <= ${windowStartCutoff} THEN ${nowSeconds} ELSE ${rateLimits.windowStart} END`,
      },
    })
    .returning({ count: rateLimits.count })

  const count = rows[0]?.count ?? 1
  if (count > rule.limit) {
    throw new ApiError('RATE_LIMITED', { details: { retryAfterSeconds: rule.windowSeconds } })
  }
  return rule.limit - count
}

/**
 * Build a rate-limit key.
 *
 * Note what is NOT in it: the invitation token. Keying a counter by the secret being guessed would
 * write that secret into the database in plaintext, which is the one thing the invitation design
 * spends effort avoiding. Credential paths are keyed by client IP instead.
 */
export function rateLimitKey(scope: keyof typeof RATE_LIMITS, discriminator: string): string {
  return `${scope}:${discriminator}`
}

/** The client's address, as Cloudflare reports it. Falls back to a constant so the limit still binds. */
export function clientAddress(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
