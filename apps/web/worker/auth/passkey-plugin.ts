/**
 * The passkey plugin: invitation redemption, passkey registration and passkey authentication,
 * implemented as Better Auth endpoints.
 *
 * These live inside Better Auth rather than beside it in Hono so that session issuance goes
 * through `setSessionCookie` — the framework's own signed-cookie path, with its expiry, cookie
 * cache and `dontRememberMe` handling — instead of a second, parallel implementation of session
 * cookies that would inevitably drift from the first.
 *
 * The flow, end to end:
 *
 *   POST /api/auth/aat/invitation/redeem   { token }
 *        → claims the invitation (race-safe, see auth/invitations.ts)
 *        → issues an opaque registration context and a WebAuthn challenge
 *   POST /api/auth/aat/passkey/register    { registrationContext, credential }
 *        → consumes the challenge, verifies attestation, spends the invitation,
 *          creates the user with a synthetic address, stores the credential, opens a session
 *   POST /api/auth/aat/passkey/authenticate/options  { }
 *        → issues a single-use challenge
 *   POST /api/auth/aat/passkey/authenticate/verify   { challengeId, credential }
 *        → verifies the assertion, advances the signature counter, opens a session
 *
 * Challenges and registration contexts are stored in Better Auth's `verification` table and read
 * back with `consumeVerificationValue`, which deletes and returns a row atomically. That is what
 * makes a challenge single-use: a replayed ceremony finds nothing to consume and fails, without
 * this code having to implement its own compare-and-delete.
 */

import { ApiError, buildApiErrorPayload, capabilitiesForRole, type ErrorCode, type Role } from '@aat/shared'
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { and, eq } from 'drizzle-orm'
import * as z from 'zod'
import type { WorkerConfig } from '../config.ts'
import type { Database } from '../db/client.ts'
import { passkey as passkeyTable, user as userTable } from '../db/schema.ts'
import { hashToken, newId, newSecretToken } from '../lib/ids.ts'
import { writeAuditLog } from '../services/audit.ts'
import { clientAddress, consumeRateLimit, RATE_LIMITS, rateLimitKey } from '../services/rate-limit.ts'
import { syntheticEmail } from './identity.ts'
import {
  claimInvitation,
  consumeInvitation,
  recordInvitationUser,
  resolveRegistrationContext,
} from './invitations.ts'
import { CeremonyError, newChallenge, verifyAuthentication, verifyRegistration } from './webauthn/ceremony.ts'
import { OFFERED_ALGORITHMS } from './webauthn/cose.ts'

/** Translate an AAT error code into the HTTP error Better Auth's router will serialise. */
function toApiError(code: ErrorCode, details?: Record<string, unknown>): APIError {
  const payload = buildApiErrorPayload(code, details === undefined ? {} : { details })
  return new APIError(payload.httpStatus as 400, { ...payload, message: payload.message })
}

function rethrow(error: unknown): never {
  if (error instanceof ApiError) throw toApiError(error.code, error.details)
  throw error
}

/** How long an authentication challenge stays valid. Long enough for a fingerprint, no longer. */
const AUTHENTICATION_CHALLENGE_TTL_SECONDS = 300

const REGISTER_CHALLENGE_PREFIX = 'aat-webauthn-register:'
const AUTHENTICATE_CHALLENGE_PREFIX = 'aat-webauthn-authenticate:'

const registrationCredentialSchema = z.object({
  id: z.string().min(1).max(1400),
  clientDataJson: z.string().min(1).max(20_000),
  attestationObject: z.string().min(1).max(40_000),
  transports: z.array(z.string().max(32)).max(8).optional(),
})

const authenticationCredentialSchema = z.object({
  id: z.string().min(1).max(1400),
  clientDataJson: z.string().min(1).max(20_000),
  authenticatorData: z.string().min(1).max(10_000),
  signature: z.string().min(1).max(10_000),
  userHandle: z.string().max(1400).nullish(),
})

export interface AatPasskeyOptions {
  db: Database
  config: WorkerConfig
}

interface StoredRegistrationChallenge {
  challenge: string
  /** The id the user will be created with, fixed at claim time so the credential's user handle matches. */
  pendingUserId: string
  invitationId: string
}

interface StoredAuthenticationChallenge {
  challenge: string
}

export function aatPasskey({ db, config }: AatPasskeyOptions) {
  return {
    id: 'aat-passkey',
    endpoints: {
      /**
       * Exchange an invitation token for a registration context and a WebAuthn challenge.
       *
       * The response is the only place the registration context ever appears in plaintext.
       */
      aatRedeemInvitation: createAuthEndpoint(
        '/aat/invitation/redeem',
        { method: 'POST', body: z.object({ token: z.string().min(1).max(512) }) },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers()
          await consumeRateLimit(
            db,
            rateLimitKey('inviteRedeem', clientAddress(headers)),
            RATE_LIMITS.inviteRedeem,
          ).catch(rethrow)

          const now = new Date()
          let claimed: Awaited<ReturnType<typeof claimInvitation>>
          try {
            claimed = await claimInvitation(db, ctx.body.token, now)
          } catch (error) {
            await writeAuditLog(db, {
              actorUserId: null,
              action: 'invitation.redeem_failed',
              // No token, no hash: the audit log records that a redemption failed and from where,
              // never the secret that was presented.
              details: { reason: error instanceof ApiError ? error.code : 'unknown' },
              headers,
            })
            rethrow(error)
          }

          const pendingUserId = claimed.targetUserId ?? newId()
          const challenge = newChallenge()
          const stored: StoredRegistrationChallenge = {
            challenge,
            pendingUserId,
            invitationId: claimed.invitationId,
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: REGISTER_CHALLENGE_PREFIX + (await hashToken(claimed.registrationContext)),
            value: JSON.stringify(stored),
            expiresAt: claimed.contextExpiresAt,
          })

          // On recovery, tell the authenticator which credentials this user already has so it can
          // avoid silently creating a second credential on the same device.
          const existing =
            claimed.targetUserId === null
              ? []
              : await db
                  .select({ credentialID: passkeyTable.credentialID, transports: passkeyTable.transports })
                  .from(passkeyTable)
                  .where(eq(passkeyTable.userId, claimed.targetUserId))

          await writeAuditLog(db, {
            actorUserId: null,
            action: 'invitation.claim',
            targetType: 'invitation',
            targetId: claimed.invitationId,
            details: { kind: claimed.kind },
            headers,
          })

          return ctx.json({
            registrationContext: claimed.registrationContext,
            expiresAt: claimed.contextExpiresAt.toISOString(),
            kind: claimed.kind,
            options: {
              challenge,
              rp: { id: config.rpId, name: config.rpName },
              user: {
                id: pendingUserId,
                name: claimed.displayName,
                displayName: claimed.displayName,
              },
              pubKeyCredParams: OFFERED_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
              timeout: 120_000,
              attestation: 'none',
              authenticatorSelection: {
                residentKey: 'required',
                requireResidentKey: true,
                userVerification: 'required',
              },
              excludeCredentials: existing.map((row) => ({
                type: 'public-key',
                id: row.credentialID,
                ...(row.transports ? { transports: JSON.parse(row.transports) as string[] } : {}),
              })),
            },
          })
        },
      ),

      /** Complete a registration ceremony: create (or extend) the user and open a session. */
      aatRegisterPasskey: createAuthEndpoint(
        '/aat/passkey/register',
        {
          method: 'POST',
          body: z.object({
            registrationContext: z.string().min(1).max(512),
            credential: registrationCredentialSchema,
          }),
        },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers()
          await consumeRateLimit(
            db,
            rateLimitKey('passkeyRegister', clientAddress(headers)),
            RATE_LIMITS.passkeyRegister,
          ).catch(rethrow)

          const now = new Date()
          const resolved = await resolveRegistrationContext(db, ctx.body.registrationContext, now).catch(
            rethrow,
          )

          const contextHash = await hashToken(ctx.body.registrationContext)
          const verification = await ctx.context.internalAdapter.consumeVerificationValue(
            REGISTER_CHALLENGE_PREFIX + contextHash,
          )
          if (!verification) {
            // No challenge left to consume: either this context already completed a ceremony, or
            // the challenge expired. Both are replay-shaped, so both are refused.
            throw toApiError('INVITE_INVALID', { reason: 'challenge_not_pending' })
          }
          const stored = JSON.parse(verification.value) as StoredRegistrationChallenge

          let verified: Awaited<ReturnType<typeof verifyRegistration>>
          try {
            verified = await verifyRegistration(ctx.body.credential, {
              rpId: config.rpId,
              trustedOrigins: config.trustedOrigins,
              expectedChallenge: stored.challenge,
              requireUserVerification: true,
            })
          } catch (error) {
            if (error instanceof CeremonyError) {
              throw toApiError('INVITE_INVALID', { reason: 'ceremony_failed' })
            }
            throw error
          }

          const [duplicate] = await db
            .select({ id: passkeyTable.id })
            .from(passkeyTable)
            .where(eq(passkeyTable.credentialID, verified.credentialId))
            .limit(1)
          if (duplicate) {
            throw toApiError('FORBIDDEN', { reason: 'credential_already_registered' })
          }

          const userId = stored.pendingUserId

          // Spend the invitation BEFORE creating anything. If this fails, another ceremony has
          // already completed against the same invitation and no second user must appear. The
          // reverse order would leave a window in which a claim expires, the invitation returns to
          // `pending`, and a second user is created from one invitation.
          const spent = await consumeInvitation(
            db,
            resolved.invitationId,
            ctx.body.registrationContext,
            userId,
            now,
          )
          if (!spent) {
            throw toApiError('INVITE_USED')
          }

          if (resolved.kind === 'registration') {
            await ctx.context.internalAdapter.createUser({
              id: userId,
              name: resolved.displayName,
              // Synthetic and non-routable — see auth/identity.ts. No real address is ever collected.
              email: syntheticEmail(userId),
              emailVerified: false,
              role: resolved.role,
              banned: false,
            })
          }

          await recordInvitationUser(db, resolved.invitationId, userId)

          const [account] = await db.select().from(userTable).where(eq(userTable.id, userId)).limit(1)
          if (!account) {
            throw toApiError('INTERNAL', { reason: 'user_missing_after_registration' })
          }

          await db.insert(passkeyTable).values({
            id: newId(),
            name: null,
            publicKey: verified.publicKey,
            userId,
            credentialID: verified.credentialId,
            counter: verified.signCount,
            deviceType: verified.deviceType,
            backedUp: verified.backedUp,
            transports: ctx.body.credential.transports
              ? JSON.stringify(ctx.body.credential.transports)
              : null,
            aaguid: verified.aaguid,
            algorithm: verified.algorithm,
            createdAt: now,
            lastUsedAt: null,
          })

          await writeAuditLog(db, {
            actorUserId: userId,
            action: resolved.kind === 'recovery' ? 'passkey.recover' : 'user.register',
            targetType: 'user',
            targetId: userId,
            details: { invitationId: resolved.invitationId, role: resolved.role },
            headers,
          })

          const session = await ctx.context.internalAdapter.createSession(userId)
          await setSessionCookie(ctx, { session, user: account })

          return ctx.json({
            user: { id: account.id, displayName: account.name, role: account.role },
            capabilities: capabilitiesForRole(account.role as Role),
          })
        },
      ),

      /** Issue a single-use authentication challenge. */
      aatAuthenticationOptions: createAuthEndpoint(
        '/aat/passkey/authenticate/options',
        { method: 'POST' },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers()
          await consumeRateLimit(
            db,
            rateLimitKey('passkeyAuthenticate', clientAddress(headers)),
            RATE_LIMITS.passkeyAuthenticate,
          ).catch(rethrow)

          const challengeId = newSecretToken()
          const challenge = newChallenge()
          const stored: StoredAuthenticationChallenge = { challenge }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: AUTHENTICATE_CHALLENGE_PREFIX + (await hashToken(challengeId)),
            value: JSON.stringify(stored),
            expiresAt: new Date(Date.now() + AUTHENTICATION_CHALLENGE_TTL_SECONDS * 1000),
          })

          return ctx.json({
            challengeId,
            options: {
              challenge,
              rpId: config.rpId,
              timeout: 120_000,
              userVerification: 'required',
              // Empty: credentials are discoverable (resident), so the authenticator offers the
              // right one without the server first revealing which credentials exist for a user —
              // which would be an account-enumeration oracle on an unauthenticated endpoint.
              allowCredentials: [],
            },
          })
        },
      ),

      /** Complete an authentication ceremony and open a session. */
      aatAuthenticationVerify: createAuthEndpoint(
        '/aat/passkey/authenticate/verify',
        {
          method: 'POST',
          body: z.object({
            challengeId: z.string().min(1).max(512),
            credential: authenticationCredentialSchema,
          }),
        },
        async (ctx) => {
          const headers = ctx.headers ?? new Headers()
          await consumeRateLimit(
            db,
            rateLimitKey('passkeyAuthenticate', clientAddress(headers)),
            RATE_LIMITS.passkeyAuthenticate,
          ).catch(rethrow)

          const verification = await ctx.context.internalAdapter.consumeVerificationValue(
            AUTHENTICATE_CHALLENGE_PREFIX + (await hashToken(ctx.body.challengeId)),
          )
          if (!verification) {
            throw toApiError('AUTH_REQUIRED', { reason: 'challenge_not_pending' })
          }
          const stored = JSON.parse(verification.value) as StoredAuthenticationChallenge

          const [credential] = await db
            .select()
            .from(passkeyTable)
            .where(eq(passkeyTable.credentialID, ctx.body.credential.id))
            .limit(1)
          if (!credential) {
            await writeAuditLog(db, {
              actorUserId: null,
              action: 'passkey.authenticate_failed',
              details: { reason: 'unknown_credential' },
              headers,
            })
            throw toApiError('AUTH_REQUIRED', { reason: 'unknown_credential' })
          }

          let result: Awaited<ReturnType<typeof verifyAuthentication>>
          try {
            result = await verifyAuthentication(
              ctx.body.credential,
              {
                credentialId: credential.credentialID,
                publicKey: credential.publicKey,
                counter: credential.counter,
              },
              {
                rpId: config.rpId,
                trustedOrigins: config.trustedOrigins,
                expectedChallenge: stored.challenge,
                requireUserVerification: true,
              },
            )
          } catch (error) {
            if (error instanceof CeremonyError) {
              await writeAuditLog(db, {
                actorUserId: credential.userId,
                action: 'passkey.authenticate_failed',
                targetType: 'passkey',
                targetId: credential.id,
                details: { reason: 'ceremony_failed' },
                headers,
              })
              throw toApiError('AUTH_REQUIRED', { reason: 'ceremony_failed' })
            }
            throw error
          }

          const [account] = await db
            .select()
            .from(userTable)
            .where(eq(userTable.id, credential.userId))
            .limit(1)
          if (!account) {
            throw toApiError('AUTH_REQUIRED', { reason: 'unknown_user' })
          }
          if (account.banned) {
            throw toApiError('FORBIDDEN', { reason: 'banned' })
          }

          await db
            .update(passkeyTable)
            .set({ counter: result.newSignCount, backedUp: result.backedUp, lastUsedAt: new Date() })
            .where(and(eq(passkeyTable.id, credential.id)))

          await writeAuditLog(db, {
            actorUserId: account.id,
            action: 'passkey.authenticate',
            targetType: 'passkey',
            targetId: credential.id,
            headers,
          })

          const session = await ctx.context.internalAdapter.createSession(account.id)
          await setSessionCookie(ctx, { session, user: account })

          return ctx.json({
            user: { id: account.id, displayName: account.name, role: account.role },
            capabilities: capabilitiesForRole(account.role as Role),
          })
        },
      ),
    },
  } satisfies BetterAuthPlugin
}
