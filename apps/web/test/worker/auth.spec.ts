/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Authentication: invitations, passkey registration, passkey sign-in.
 *
 * The invitation tests are the ones that matter most. An invitation is the only way into this
 * system, so "valid, invalid, expired, revoked, reused, and two at once" is the complete set of
 * things that can happen to one, and each is asserted rather than assumed.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createInvitation, revokeInvitation } from '../../worker/auth/invitations.ts'
import { registrationInvites, user as userTable } from '../../worker/db/schema.ts'
import { VirtualAuthenticator } from './helpers/authenticator.ts'
import {
  apiFetch,
  createUser,
  db,
  issueInvitationToken,
  ORIGIN,
  RP_ID,
  registerWithToken,
  signIn,
} from './helpers/client.ts'

async function redeem(token: string): Promise<Response> {
  return apiFetch('/api/auth/aat/invitation/redeem', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { code?: string; error?: { code?: string } }
  return body.code ?? body.error?.code
}

describe('invitation redemption', () => {
  it('accepts a valid token and issues a registration context', async () => {
    const token = await issueInvitationToken()
    const response = await redeem(token)
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      registrationContext: string
      options: { challenge: string; rp: { id: string } }
    }
    expect(body.registrationContext.length).toBeGreaterThan(20)
    expect(body.options.rp.id).toBe(RP_ID)
  })

  it('rejects an unknown token', async () => {
    const response = await redeem('not-a-real-token')
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('INVITE_INVALID')
  })

  it('rejects an expired token', async () => {
    const invitation = await createInvitation(
      db(),
      {
        kind: 'registration',
        role: 'Researcher',
        displayName: '期限切れ',
        ttlSeconds: 60,
        createdByUserId: null,
      },
      new Date(Date.now() - 3600_000),
    )
    const response = await redeem(invitation.token)
    expect(response.status).toBe(410)
    expect(await errorCode(response)).toBe('INVITE_EXPIRED')
  })

  it('rejects a revoked token', async () => {
    const invitation = await createInvitation(db(), {
      kind: 'registration',
      role: 'Researcher',
      displayName: '取り消し済み',
      ttlSeconds: 3600,
      createdByUserId: null,
    })
    // Revocation is by id — the plaintext token is not needed and, in production, no longer exists.
    expect(await revokeInvitation(db(), invitation.id, 'someone')).toBe(true)

    const response = await redeem(invitation.token)
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('INVITE_INVALID')
  })

  it('rejects a token that has already been used', async () => {
    const token = await issueInvitationToken()
    await registerWithToken(token)

    const response = await redeem(token)
    expect(response.status).toBe(409)
    expect(await errorCode(response)).toBe('INVITE_USED')
  })

  it('lets exactly one of two concurrent redemptions win', async () => {
    const token = await issueInvitationToken()

    // Both requests are in flight at once. The claim is a single conditional UPDATE, so one of
    // them observes `status = 'pending'` and writes, and the other sees zero rows affected.
    const [first, second] = await Promise.all([redeem(token), redeem(token)])

    const statuses = [first.status, second.status].sort()
    expect(statuses).toEqual([200, 409])

    const loser = first.status === 409 ? first : second
    expect(await errorCode(loser)).toBe('INVITE_USED')

    const [row] = await db()
      .select()
      .from(registrationInvites)
      .where(eq(registrationInvites.id, (await currentInvitationId(token)) ?? ''))
      .limit(1)
    expect(row?.status).toBe('claimed')
  })
})

/** Find an invitation by token, the way the server does: by hash. */
async function currentInvitationId(token: string): Promise<string | undefined> {
  const { hashToken } = await import('../../worker/lib/ids.ts')
  const [row] = await db()
    .select({ id: registrationInvites.id })
    .from(registrationInvites)
    .where(eq(registrationInvites.tokenHash, await hashToken(token)))
    .limit(1)
  return row?.id
}

describe('passkey registration', () => {
  it('creates a user with a synthetic, non-routable address and never a real one', async () => {
    const user = await createUser({ displayName: '宇宙 太郎' })
    const [row] = await db().select().from(userTable).where(eq(userTable.id, user.userId)).limit(1)

    expect(row?.email).toBe(`${user.userId.toLowerCase()}@aat.invalid`)
    expect(row?.name).toBe('宇宙 太郎')
    // The address is an artefact of the auth framework's data model. It must never be surfaced.
    const me = await apiFetch('/api/v1/me', { cookie: user.cookie })
    expect(await me.text()).not.toContain('@aat.invalid')
  })

  it('assigns the role the invitation carried', async () => {
    const viewer = await createUser({ role: 'Viewer' })
    expect(viewer.role).toBe('Viewer')
    const admin = await createUser({ role: 'Admin' })
    expect(admin.role).toBe('Admin')
  })

  it('refuses a registration whose challenge was signed for another relying party', async () => {
    const token = await issueInvitationToken()
    const redeemed = (await (await redeem(token)).json()) as {
      registrationContext: string
      options: { challenge: string }
    }

    const attacker = new VirtualAuthenticator('evil.test', ORIGIN)
    const credential = await attacker.register(redeemed.options.challenge)

    const response = await apiFetch('/api/auth/aat/passkey/register', {
      method: 'POST',
      body: JSON.stringify({ registrationContext: redeemed.registrationContext, credential }),
    })
    expect(response.status).toBe(400)
  })

  it('refuses a registration made from an untrusted origin', async () => {
    const token = await issueInvitationToken()
    const redeemed = (await (await redeem(token)).json()) as {
      registrationContext: string
      options: { challenge: string }
    }

    const authenticator = new VirtualAuthenticator(RP_ID, 'https://phishing.test')
    const credential = await authenticator.register(redeemed.options.challenge)

    const response = await apiFetch('/api/auth/aat/passkey/register', {
      method: 'POST',
      body: JSON.stringify({ registrationContext: redeemed.registrationContext, credential }),
    })
    expect(response.status).toBe(400)
  })

  it('consumes the challenge, so the same ceremony cannot be replayed', async () => {
    const token = await issueInvitationToken()
    const redeemed = (await (await redeem(token)).json()) as {
      registrationContext: string
      options: { challenge: string }
    }

    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    const credential = await authenticator.register(redeemed.options.challenge)
    const body = JSON.stringify({ registrationContext: redeemed.registrationContext, credential })

    const first = await apiFetch('/api/auth/aat/passkey/register', { method: 'POST', body })
    expect(first.status).toBe(200)

    const replay = await apiFetch('/api/auth/aat/passkey/register', { method: 'POST', body })
    expect(replay.status).not.toBe(200)
  })
})

describe('passkey authentication', () => {
  it('signs an existing user in with their credential', async () => {
    const user = await createUser()
    const cookie = await signIn(user)
    expect(cookie).not.toBe('')

    const me = await apiFetch('/api/v1/me', { cookie })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { id: string } }
    expect(body.user.id).toBe(user.userId)
  })

  it('rejects an assertion whose signature counter did not advance', async () => {
    const user = await createUser()
    await signIn(user)

    const options = await apiFetch('/api/auth/aat/passkey/authenticate/options', { method: 'POST' })
    const issued = (await options.json()) as { challengeId: string; options: { challenge: string } }
    // A counter that stalls is the documented clone signal: two authenticators answering for one
    // credential.
    const assertion = await user.authenticator.authenticate(issued.options.challenge, {
      signCountOverride: 1,
    })

    const response = await apiFetch('/api/auth/aat/passkey/authenticate/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: issued.challengeId, credential: assertion }),
    })
    expect(response.status).toBe(401)
  })

  it('rejects an unknown credential without revealing whether the user exists', async () => {
    const options = await apiFetch('/api/auth/aat/passkey/authenticate/options', { method: 'POST' })
    const issued = (await options.json()) as { challengeId: string; options: { challenge: string } }
    const stranger = new VirtualAuthenticator(RP_ID, ORIGIN)
    const assertion = await stranger.authenticate(issued.options.challenge)

    const response = await apiFetch('/api/auth/aat/passkey/authenticate/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: issued.challengeId, credential: assertion }),
    })
    expect(response.status).toBe(401)
  })

  it('offers no credential list to an anonymous caller', async () => {
    // allowCredentials must stay empty: populating it would let anyone enumerate which credentials
    // exist for a user before authenticating.
    const options = await apiFetch('/api/auth/aat/passkey/authenticate/options', { method: 'POST' })
    const issued = (await options.json()) as { options: { allowCredentials: unknown[] } }
    expect(issued.options.allowCredentials).toEqual([])
  })
})

describe('recovery', () => {
  it('adds a credential to an existing user without creating a second account', async () => {
    const user = await createUser()

    const recovery = await createInvitation(db(), {
      kind: 'recovery',
      role: user.role,
      displayName: user.displayName,
      targetUserId: user.userId,
      ttlSeconds: 3600,
      createdByUserId: null,
    })

    const redeemed = (await (await redeem(recovery.token)).json()) as {
      registrationContext: string
      kind: string
      options: { challenge: string; user: { id: string } }
    }
    expect(redeemed.kind).toBe('recovery')
    expect(redeemed.options.user.id).toBe(user.userId)

    const replacement = new VirtualAuthenticator(RP_ID, ORIGIN)
    const credential = await replacement.register(redeemed.options.challenge)
    const response = await apiFetch('/api/auth/aat/passkey/register', {
      method: 'POST',
      body: JSON.stringify({ registrationContext: redeemed.registrationContext, credential }),
    })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { user: { id: string } }
    expect(body.user.id).toBe(user.userId)

    const passkeys = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const list = (await passkeys.json()) as { passkeys: unknown[] }
    expect(list.passkeys).toHaveLength(2)
  })

  it("refuses to delete a user's last passkey", async () => {
    const user = await createUser()
    const passkeys = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const list = (await passkeys.json()) as { passkeys: { id: string }[] }
    expect(list.passkeys).toHaveLength(1)

    const response = await apiFetch(`/api/v1/me/passkeys/${list.passkeys[0]?.id}`, {
      method: 'DELETE',
      cookie: user.cookie,
    })
    // With no password and no email, the last passkey is the account. Removing it is not a
    // reversible mistake, so it is refused rather than confirmed.
    expect(response.status).toBe(403)
  })
})
