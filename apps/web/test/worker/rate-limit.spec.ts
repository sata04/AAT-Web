/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Rate limiting on the credential paths.
 *
 * Invitation redemption is the only unauthenticated way into this system, so it is the only place
 * a guessing attack has to work. The limit is deliberately strict, and the counter is a single
 * atomic statement rather than a read followed by a write — a limiter that loses under concurrency
 * is a limiter an attacker simply parallelises around.
 *
 * Every request in a test here happens inside ONE test, because the suite's setup resets the
 * counters between tests (see setup.ts).
 */

import { describe, expect, it } from 'vitest'
import { apiFetch, issueInvitationToken } from './helpers/client.ts'

async function redeem(token: string): Promise<Response> {
  return apiFetch('/api/auth/aat/invitation/redeem', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

describe('invitation redemption rate limit', () => {
  it('stops guessing after the window allowance is spent', async () => {
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt++) {
      statuses.push((await redeem(`guess-${attempt}`)).status)
    }

    // The first attempts are answered honestly (the token is invalid); once the window's allowance
    // is gone every further attempt is refused without touching the invitations table at all.
    expect(statuses.filter((status) => status === 400).length).toBe(10)
    expect(statuses.filter((status) => status === 429).length).toBe(2)
  })

  it('counts concurrent attempts too', async () => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, (_, index) => redeem(`concurrent-${index}`)),
    )
    const limited = responses.filter((response) => response.status === 429)
    // A read-then-write limiter would let all fifteen through; the atomic upsert does not.
    expect(limited.length).toBeGreaterThan(0)
  })

  it('does not spend a valid invitation when the request is rate limited', async () => {
    const token = await issueInvitationToken()
    for (let attempt = 0; attempt < 10; attempt++) {
      await redeem(`filler-${attempt}`)
    }

    const limited = await redeem(token)
    expect(limited.status).toBe(429)

    // The limiter runs before the invitation is touched, so the token is still redeemable once the
    // window rolls over — a rate limit must not consume the credential it is protecting.
    const { env } = await import('cloudflare:test')
    await env.DB.prepare('DELETE FROM rate_limits').run()

    const allowed = await redeem(token)
    expect(allowed.status).toBe(200)
  })
})
