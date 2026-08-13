/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Authentication: invitations, passkey registration, passkey sign-in.
 *
 * WebAuthn itself is `@simplewebauthn/server`'s, reached through `@better-auth/passkey`, and these
 * tests do not re-litigate it. What they assert is the part that is AAT's: that the plugin is
 * *configured* against the relying party and origins this deployment was given rather than against
 * anything the request supplied, that the guarantees the plugin does not offer — user verification,
 * the ban check, the last-passkey rule — are imposed anyway, and that an invitation is spent
 * exactly once no matter how the ceremony goes.
 *
 * The invitation tests are the ones that matter most. An invitation is the only way into this
 * system, so "valid, invalid, expired, revoked, reused, and two at once" is the complete set of
 * things that can happen to one, and each is asserted rather than assumed.
 */

import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createInvitation } from '../../worker/auth/invitations.ts'
import {
  auditLogs,
  passkey as passkeyTable,
  registrationInvites,
  user as userTable,
} from '../../worker/db/schema.ts'
import { VirtualAuthenticator } from './helpers/authenticator.ts'
import {
  apiFetch,
  authenticationOptions,
  createUser,
  db,
  issueInvitationToken,
  ORIGIN,
  RP_ID,
  redeemInvitation as redeem,
  registerWithToken,
  registrationOptions,
  sessionCookie,
  signIn,
  verifyAuthentication,
  verifyRegistration,
} from './helpers/client.ts'

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { code?: string; error?: { code?: string } }
  return body.code ?? body.error?.code
}

async function errorReason(response: Response): Promise<unknown> {
  const body = (await response.json()) as { details?: { reason?: unknown } }
  return body.details?.reason
}

/** Redeem a token and return the registration context it yields. */
async function contextFor(token: string): Promise<string> {
  const response = await redeem(token)
  if (response.status !== 200) {
    throw new Error(`redeem failed: ${response.status} ${await response.text()}`)
  }
  return ((await response.json()) as { registrationContext: string }).registrationContext
}

async function countUsers(): Promise<number> {
  const rows = await db().select({ id: userTable.id }).from(userTable)
  return rows.length
}

async function countPasskeys(): Promise<number> {
  const rows = await db().select({ id: passkeyTable.id }).from(passkeyTable)
  return rows.length
}

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

describe('invitation redemption', () => {
  it('accepts a valid token and issues a registration context', async () => {
    const token = await issueInvitationToken()
    const response = await redeem(token)
    expect(response.status).toBe(200)

    const body = (await response.json()) as { registrationContext: string; kind: string }
    expect(body.registrationContext.length).toBeGreaterThan(20)
    expect(body.kind).toBe('registration')
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
    const admin = await createUser({ role: 'Admin' })
    const created = await apiFetch('/api/v1/admin/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({
        kind: 'registration',
        role: 'Researcher',
        displayName: '取り消し済み',
        ttlHours: 24,
      }),
    })
    expect(created.status).toBe(201)
    const invitation = (await created.json()) as { invitation: { id: string; token: string } }

    // Revocation is by id — the plaintext token is not needed and, in production, no longer exists.
    const revoked = await apiFetch(`/api/v1/admin/invitations/${invitation.invitation.id}/revoke`, {
      method: 'POST',
      cookie: admin.cookie,
    })
    expect(revoked.status).toBe(200)

    const response = await redeem(invitation.invitation.token)
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

describe('registration options', () => {
  it('are issued for the configured relying party, not for anything the request named', async () => {
    const ceremony = await apiFetch(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(
        await contextFor(await issueInvitationToken()),
      )}`,
    )
    expect(ceremony.status).toBe(200)

    const options = (await ceremony.json()) as {
      rp: { id: string; name: string }
      challenge: string
      authenticatorSelection: { userVerification: string; residentKey: string }
    }
    // AAT_RP_ID / AAT_RP_NAME, from configuration. worker/config.ts refuses to derive either from
    // the request, and this is the assertion that the plugin is told the configured value.
    expect(options.rp.id).toBe(RP_ID)
    expect(options.rp.name).toBe('AAT Test')
    expect(options.challenge.length).toBeGreaterThan(20)
    // Discoverable credential, verified user: the plugin's defaults are "preferred" for both.
    expect(options.authenticatorSelection.residentKey).toBe('required')
    expect(options.authenticatorSelection.userVerification).toBe('required')
  })

  it('refuses to start a ceremony without a registration context', async () => {
    const response = await apiFetch('/api/auth/passkey/generate-register-options')
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('INVITE_INVALID')
  })

  it('refuses a registration context that was never claimed', async () => {
    const response = await apiFetch('/api/auth/passkey/generate-register-options?context=invented')
    expect(response.status).toBe(400)
    expect(await errorCode(response)).toBe('INVITE_INVALID')
  })
})

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

  it('establishes a session, so the ceremony is also the sign-in', async () => {
    // `POST /passkey/verify-registration` does not open a session by itself; AAT opens one in
    // `afterVerification`. Without that a newly invited researcher would complete a ceremony and
    // then be shown a sign-in screen.
    const user = await createUser()
    expect(user.cookie).not.toBe('')
    const me = await apiFetch('/api/v1/me', { cookie: user.cookie })
    expect(me.status).toBe(200)
  })

  it('refuses a registration whose challenge was signed for another relying party', async () => {
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })

    const attacker = new VirtualAuthenticator('evil.test', ORIGIN)
    const response = await verifyRegistration(ceremony, await attacker.register(ceremony.challenge))

    expect(response.status).toBe(400)
  })

  it('refuses a registration made from an untrusted origin', async () => {
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })

    // The Origin *header* is this deployment's; the origin inside clientDataJSON is not. That is
    // the shape a phished ceremony actually has, and it is why `origin` is configured rather than
    // read from the request.
    const authenticator = new VirtualAuthenticator(RP_ID, 'https://phishing.test')
    const response = await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))

    expect(response.status).toBe(400)
  })

  it('refuses a registration signed for a challenge this server never issued', async () => {
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })

    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    const response = await verifyRegistration(
      ceremony,
      await authenticator.register('bm90LXRoZS1jaGFsbGVuZ2UtdGhpcy1zZXJ2ZXItaXNzdWVk'),
    )

    expect(response.status).toBe(400)
  })

  it('refuses a credential that proves presence but not user verification', async () => {
    // The plugin verifies registrations with `requireUserVerification: false`. A tap on an
    // unlocked security key is not the account owner; AAT re-imposes the requirement.
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })

    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    const response = await verifyRegistration(
      ceremony,
      await authenticator.register(ceremony.challenge, { userVerified: false }),
    )

    expect(response.status).toBe(403)
    expect(await errorReason(response)).toBe('user_verification_required')
  })

  it('consumes the challenge, so the same ceremony cannot be replayed', async () => {
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    const credential = await authenticator.register(ceremony.challenge)

    const first = await verifyRegistration(ceremony, credential)
    expect(first.status).toBe(200)

    const replay = await verifyRegistration(ceremony, credential)
    expect(replay.status).not.toBe(200)
  })

  it('does not spend the invitation when the attestation is refused', async () => {
    // The seam that spends an invitation runs only after the attestation has verified. A user who
    // dismisses the platform prompt, or an authenticator that answers wrongly, must not cost the
    // administrator a new invitation.
    const token = await issueInvitationToken()
    const context = await contextFor(token)

    const failed = await registrationOptions({ context })
    const wrongRelyingParty = new VirtualAuthenticator('evil.test', ORIGIN)
    expect(
      (await verifyRegistration(failed, await wrongRelyingParty.register(failed.challenge))).status,
    ).toBe(400)

    const invitationId = (await currentInvitationId(token)) ?? ''
    const [afterFailure] = await db()
      .select()
      .from(registrationInvites)
      .where(eq(registrationInvites.id, invitationId))
      .limit(1)
    expect(afterFailure?.status).toBe('claimed')
    expect(afterFailure?.usedAt).toBeNull()

    // And the same context still completes.
    const retry = await registrationOptions({ context })
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect((await verifyRegistration(retry, await authenticator.register(retry.challenge))).status).toBe(200)

    const [afterSuccess] = await db()
      .select()
      .from(registrationInvites)
      .where(eq(registrationInvites.id, invitationId))
      .limit(1)
    expect(afterSuccess?.status).toBe('used')
  })

  it('produces exactly one user when two ceremonies race one invitation', async () => {
    /*
     * The design decision this migration had to get right. One registration context can start any
     * number of ceremonies — each `generate-register-options` call issues its own challenge and
     * cookie — so "two ceremonies, one invitation" is reachable without any race on redemption at
     * all. `consumeInvitation` is a single conditional UPDATE inside `afterVerification`, run
     * before any user is created, so exactly one of them can proceed.
     */
    const token = await issueInvitationToken()
    const context = await contextFor(token)

    const firstCeremony = await registrationOptions({ context })
    const secondCeremony = await registrationOptions({ context })
    const first = new VirtualAuthenticator(RP_ID, ORIGIN)
    const second = new VirtualAuthenticator(RP_ID, ORIGIN)
    const firstCredential = await first.register(firstCeremony.challenge)
    const secondCredential = await second.register(secondCeremony.challenge)

    const usersBefore = await countUsers()
    const passkeysBefore = await countPasskeys()

    const [a, b] = await Promise.all([
      verifyRegistration(firstCeremony, firstCredential),
      verifyRegistration(secondCeremony, secondCredential),
    ])

    const statuses = [a.status, b.status].sort()
    expect(statuses[0]).toBe(200)
    expect(statuses[1]).not.toBe(200)

    // One winner means one user and one credential. Two would be unrecoverable: an invitation is
    // the only authorisation this system has for an account existing.
    expect(await countUsers()).toBe(usersBefore + 1)
    expect(await countPasskeys()).toBe(passkeysBefore + 1)

    /*
     * Which refusal the loser gets depends on how far it had run when the winner committed, and
     * both answers are correct: `INVITE_USED` if it reached the conditional UPDATE and lost it,
     * `INVITE_INVALID` if the winner had already spent the context by the time it looked the
     * context up. Pinning one of them would be pinning a scheduling accident. What must be exact
     * is that it was refused, and the row counts above already say nothing was created.
     */
    const loser = a.status === 200 ? b : a
    expect(loser.status).toBeGreaterThanOrEqual(400)
    expect(['INVITE_USED', 'INVITE_INVALID']).toContain(await errorCode(loser))
  })

  it('refuses an unbounded passkey label', async () => {
    // The plugin types the passkey `name` as an unbounded string and stores it. Everything else a
    // client can put in this database has a length bound; so does this.
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)

    const response = await apiFetch('/api/auth/passkey/verify-registration', {
      method: 'POST',
      cookie: ceremony.cookie,
      body: JSON.stringify({
        response: await authenticator.register(ceremony.challenge),
        name: 'あ'.repeat(5000),
      }),
    })
    expect(response.status).toBe(403)
    expect(await errorReason(response)).toBe('passkey_name_too_long')
  })

  it('refuses a credential that is already registered to someone', async () => {
    const existing = await createUser()
    const context = await contextFor(await issueInvitationToken())
    const ceremony = await registrationOptions({ context })

    // The same authenticator, presenting the credential it already registered.
    const response = await verifyRegistration(
      ceremony,
      await existing.authenticator.register(ceremony.challenge),
    )

    expect(response.status).toBe(403)
    expect(await errorReason(response)).toBe('credential_already_registered')
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

  it('records when the credential was last used', async () => {
    const user = await createUser()
    await signIn(user)

    // `last_used_at` is AAT's column, maintained from the authentication seam — the plugin does
    // not know about it. It is what the credential-management screen reads.
    const listed = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const body = (await listed.json()) as { passkeys: { lastUsedAt: string | null }[] }
    expect(body.passkeys[0]?.lastUsedAt).not.toBeNull()
  })

  it('rejects an assertion whose signature counter did not advance', async () => {
    const user = await createUser()
    await signIn(user)

    const ceremony = await authenticationOptions()
    // A counter that stalls is the documented clone signal: two authenticators answering for one
    // credential.
    const assertion = await user.authenticator.authenticate(ceremony.challenge, { signCountOverride: 1 })

    const response = await verifyAuthentication(ceremony, assertion)
    expect(response.status).not.toBe(200)
  })

  it('rejects an assertion that proves presence but not user verification', async () => {
    const user = await createUser()
    const ceremony = await authenticationOptions()
    const assertion = await user.authenticator.authenticate(ceremony.challenge, { userVerified: false })

    const response = await verifyAuthentication(ceremony, assertion)
    expect(response.status).toBe(401)
    expect(await errorReason(response)).toBe('user_verification_required')
  })

  it('rejects an assertion made from an untrusted origin', async () => {
    const user = await createUser()
    const ceremony = await authenticationOptions()
    const assertion = await user.authenticator.authenticate(ceremony.challenge, {
      origin: 'https://phishing.test',
    })

    const response = await verifyAuthentication(ceremony, assertion)
    expect(response.status).not.toBe(200)
  })

  it('rejects an unknown credential without revealing whether the user exists', async () => {
    const ceremony = await authenticationOptions()
    const stranger = new VirtualAuthenticator(RP_ID, ORIGIN)
    const response = await verifyAuthentication(ceremony, await stranger.authenticate(ceremony.challenge))

    expect(response.status).toBe(401)
  })

  it('offers no credential list to an anonymous caller', async () => {
    // allowCredentials must stay empty: populating it would let anyone enumerate which credentials
    // exist for a user before authenticating.
    const ceremony = await authenticationOptions()
    expect(ceremony.allowCredentials).toEqual([])
  })

  it('refuses a banned user before any session exists', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()

    const banned = await apiFetch(`/api/v1/admin/users/${user.userId}`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: JSON.stringify({ banned: true, banReason: 'test' }),
    })
    expect(banned.status).toBe(200)

    // The plugin's verify-authentication endpoint creates a session without consulting `banned`.
    // The authentication seam refuses first, so no cookie is ever issued.
    const ceremony = await authenticationOptions()
    const response = await verifyAuthentication(
      ceremony,
      await user.authenticator.authenticate(ceremony.challenge),
    )
    expect(response.status).toBe(403)
    expect(await errorReason(response)).toBe('banned')

    // Audited once, with the reason that actually applied — not once by the seam and again by the
    // generic failure hook.
    const failures = await db()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'passkey.authenticate_failed'))
    const forThisUser = failures.filter((row) => row.actorUserId === user.userId)
    expect(forThisUser).toHaveLength(1)
    expect(forThisUser[0]?.details).toContain('banned')
  })

  /**
   * REGRESSION TEST FOR A PROVEN DEFECT — currently RED. Added by the V1 security review; the
   * orchestrator owns the fix.
   *
   * The ban only refuses a *new* ceremony (the test above). A session that already exists is
   * unaffected, because nothing on the request path ever consults `user.banned`:
   *
   *  - `worker/middleware/authorize.ts:117` calls `auth.api.getSession`, which reads the session
   *    row and returns its user without a ban test — `banned` appears nowhere in better-auth
   *    outside the admin plugin;
   *  - the admin plugin's only ban enforcement is a `databaseHooks.session.create.before` hook
   *    (`better-auth/dist/plugins/admin/admin.mjs:34-48`), which fires when a session is
   *    *created* and never when one is read;
   *  - `PATCH /api/v1/admin/users/:userId` (`worker/routes/admin.ts:96`) sets the column and
   *    deletes no session rows, and there is no other route in this Worker that does.
   *
   * So a banned researcher keeps full access — including `GET /workspace/runs`, every colleague's
   * snapshot and `POST /runs` — for the remaining life of their cookie, up to fourteen days.
   *
   * Three statements in the repository assert the opposite and are wrong today:
   * `worker/middleware/authorize.ts:113-116`, `src/screens/AdminUsersScreen.tsx:22-25`, and
   * `docs/auth-security.md` ("Sessions").
   */
  it('ends an existing session when the user is banned', async () => {
    const admin = await createUser({ role: 'Admin' })
    const victim = await createUser({ role: 'Researcher' })

    expect((await apiFetch('/api/v1/me', { cookie: victim.cookie })).status).toBe(200)

    const banned = await apiFetch(`/api/v1/admin/users/${victim.userId}`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: JSON.stringify({ banned: true, banReason: 'security review regression test' }),
    })
    expect(banned.status).toBe(200)

    // Disabling an account must end it, not merely stop the next sign-in.
    expect((await apiFetch('/api/v1/me', { cookie: victim.cookie })).status).toBe(401)
    expect((await apiFetch('/api/v1/workspace/runs', { cookie: victim.cookie })).status).toBe(401)
    const created = await apiFetch('/api/v1/runs', {
      method: 'POST',
      cookie: victim.cookie,
      body: JSON.stringify({ originalFilename: '260811a_data.csv' }),
    })
    expect(created.status).toBe(401)
  })

  it('ends the session on sign-out', async () => {
    const user = await createUser()
    const cookie = await signIn(user)
    expect((await apiFetch('/api/v1/me', { cookie })).status).toBe(200)

    const out = await apiFetch('/api/auth/sign-out', { method: 'POST', cookie, body: '{}' })
    expect(out.status).toBe(200)

    // Revocation is server-side: the cookie is not merely cleared in the browser, the session row
    // is gone, so the same cookie presented again authenticates nobody.
    expect((await apiFetch('/api/v1/me', { cookie })).status).toBe(401)
  })
})

describe('multiple passkeys', () => {
  it('lets a signed-in user add a second credential to their own account', async () => {
    const user = await createUser()

    // No registration context: the plugin prefers a live session, and the seam then has no
    // invitation to spend and no user to create.
    const ceremony = await registrationOptions({ cookie: user.cookie })
    // The authenticator is told what this account already has, so it does not silently mint a
    // duplicate on the same device.
    expect(ceremony.excludeCredentials).toHaveLength(1)

    const second = new VirtualAuthenticator(RP_ID, ORIGIN)
    const added = await verifyRegistration(ceremony, await second.register(ceremony.challenge))
    expect(added.status).toBe(200)

    const listed = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const body = (await listed.json()) as { passkeys: { id: string }[] }
    expect(body.passkeys).toHaveLength(2)

    // And the new credential signs in.
    const ceremony2 = await authenticationOptions()
    const verified = await verifyAuthentication(ceremony2, await second.authenticate(ceremony2.challenge))
    expect(verified.status).toBe(200)
    const me = await apiFetch('/api/v1/me', { cookie: sessionCookie(verified) })
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(user.userId)
  })

  it('refuses an anonymous caller who has neither a session nor a context', async () => {
    const response = await apiFetch('/api/auth/passkey/generate-register-options')
    expect(response.status).toBe(400)
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

    const redeemed = await redeem(recovery.token)
    const body = (await redeemed.json()) as { registrationContext: string; kind: string }
    expect(body.kind).toBe('recovery')

    const usersBefore = await countUsers()
    const ceremony = await registrationOptions({ context: body.registrationContext })
    // A recovery ceremony knows which user it is for, so the plugin can exclude what they have.
    expect(ceremony.excludeCredentials).toHaveLength(1)

    const replacement = new VirtualAuthenticator(RP_ID, ORIGIN)
    const response = await verifyRegistration(ceremony, await replacement.register(ceremony.challenge))
    expect(response.status).toBe(200)

    expect(await countUsers()).toBe(usersBefore)
    const passkeys = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const list = (await passkeys.json()) as { passkeys: unknown[] }
    expect(list.passkeys).toHaveLength(2)

    // The recovered credential signs the same user in.
    const ceremony2 = await authenticationOptions()
    const signedIn = await verifyAuthentication(
      ceremony2,
      await replacement.authenticate(ceremony2.challenge),
    )
    expect(signedIn.status).toBe(200)
    const me = await apiFetch('/api/v1/me', { cookie: sessionCookie(signedIn) })
    expect(((await me.json()) as { user: { id: string } }).user.id).toBe(user.userId)
  })

  it("refuses to delete a user's last passkey through AAT's own route", async () => {
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

  it("refuses to delete a user's last passkey through the plugin's own route", async () => {
    // The plugin ships `POST /passkey/delete-passkey`, which enforces ownership and nothing else.
    // Guarding only AAT's route would leave the rule one HTTP call away from being bypassed.
    const user = await createUser()
    const listed = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const list = (await listed.json()) as { passkeys: { id: string }[] }

    const response = await apiFetch('/api/auth/passkey/delete-passkey', {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ id: list.passkeys[0]?.id }),
    })
    expect(response.status).toBe(403)
    expect(await errorReason(response)).toBe('cannot_delete_last_passkey')

    const still = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    expect(((await still.json()) as { passkeys: unknown[] }).passkeys).toHaveLength(1)
  })

  it('allows deleting a passkey that is not the last one', async () => {
    const user = await createUser()
    const ceremony = await registrationOptions({ cookie: user.cookie })
    const second = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect((await verifyRegistration(ceremony, await second.register(ceremony.challenge))).status).toBe(200)

    const listed = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    const list = (await listed.json()) as { passkeys: { id: string }[] }
    expect(list.passkeys).toHaveLength(2)

    const response = await apiFetch('/api/auth/passkey/delete-passkey', {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ id: list.passkeys[0]?.id }),
    })
    expect(response.status).toBe(200)

    const remaining = await apiFetch('/api/v1/me/passkeys', { cookie: user.cookie })
    expect(((await remaining.json()) as { passkeys: unknown[] }).passkeys).toHaveLength(1)
  })
})

/**
 * REGRESSION TESTS FOR A PROVEN DEFECT - currently RED. Added by the V1 security review; the
 * orchestrator owns the fix.
 *
 * Better Auth's core `POST /api/auth/update-user` is mounted by `app.all('/api/auth/*')`
 * (`worker/index.ts:41`) and is reachable by any signed-in user. Its body schema is
 * `z.record(z.string(), z.any())` (`better-auth/dist/api/routes/update-user.mjs:11`), so `name`
 * is accepted with no length bound and no character filter, and it is written straight to
 * `user.name`.
 *
 * `user.name` is the *only* human identity this system has - `docs/auth-security.md` says so
 * explicitly, because there is no email - and it is rendered, unmodified, in three places a
 * colleague sees: `GET /api/v1/workspace/runs`'s `ownerDisplayName` (`worker/routes/runs.ts:494`),
 * `GET /api/v1/me`, and the admin console's user table via `toPublicUser`
 * (`worker/auth/identity.ts:66`). None of them bounds or sanitises it.
 *
 * Two consequences, neither of which is XSS (React escapes text, and this application has no
 * `dangerouslySetInnerHTML`):
 *
 *  1. **Identity spoofing in the audit surface.** `src/admin/audit.ts` strips U+202E, zero-width
 *     and C0/C1 characters from audit *details* precisely because they let one string render as
 *     another - and the same characters pass untouched through the display name shown beside
 *     every run in the gallery and in the admin users table.
 *  2. **Unbounded storage and response size.** Every schema AAT writes carries a `.max()`; the
 *     passkey plugin's `name` is bounded for exactly this reason in
 *     `worker/auth/passkey-plugin.ts:509-518`. This larger, far more visible string has no bound.
 *
 * A display name is also meant to be set by an administrator at invitation time - nothing in
 * `worker/middleware/authorize.ts`'s policy table grants a member self-service rename.
 */
describe('the display name is the only identity, and is not self-service', () => {
  it('refuses an unbounded self-set display name', async () => {
    const user = await createUser({ role: 'Researcher' })

    const response = await apiFetch('/api/auth/update-user', {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ name: 'A'.repeat(5000) }),
    })

    expect(response.status).not.toBe(200)

    const me = await apiFetch('/api/v1/me', { cookie: user.cookie })
    const body = (await me.json()) as { user: { displayName: string } }
    expect(body.user.displayName).toBe(user.displayName)
  })

  it('refuses a display name carrying bidirectional or control characters', async () => {
    const user = await createUser({ role: 'Researcher' })

    const response = await apiFetch('/api/auth/update-user', {
      method: 'POST',
      cookie: user.cookie,
      // U+202E reverses the rendering of everything after it, which is how one member's name is
      // made to read as another's in the gallery and in the admin console.
      body: JSON.stringify({ name: '\u202E管理者 ' }),
    })

    expect(response.status).not.toBe(200)

    const me = await apiFetch('/api/v1/me', { cookie: user.cookie })
    const body = (await me.json()) as { user: { displayName: string } }
    expect(body.user.displayName).toBe(user.displayName)
  })
})
