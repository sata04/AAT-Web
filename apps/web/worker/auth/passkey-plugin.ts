/**
 * AAT's integration with the official Better Auth passkey plugin.
 *
 * The WebAuthn protocol is **not** implemented here and must never be again. `@better-auth/passkey`
 * owns attestation and assertion verification (through `@simplewebauthn/server`), challenge
 * issuance, the signed challenge cookie, the single-use verification row and the passkey table.
 * What lives in this file is the part of onboarding that is AAT's and nobody else's: invitations,
 * the synthetic identity, role assignment, the audit trail, rate limits, and the policy that a
 * user may not remove the credential that *is* their account.
 *
 * ## The flow, end to end
 *
 *   POST /api/auth/aat/invitation/redeem            { token }
 *        → claims the invitation (race-safe, see ./invitations.ts) and returns a short-lived
 *          opaque registration context. This is the only place that context exists in plaintext.
 *   GET  /api/auth/passkey/generate-register-options?context=<registrationContext>
 *        → the plugin's endpoint. `registration.requireSession: false` removes its session
 *          middleware, so `registration.resolveUser` below is asked who is registering; it
 *          validates the context and answers. The plugin stores the challenge and the context in
 *          a verification row named by a signed cookie.
 *   POST /api/auth/passkey/verify-registration      { response }
 *        → the plugin verifies the attestation, then calls `registration.afterVerification`,
 *          which is where the invitation is spent, the user created and the session opened.
 *
 * ## Two seams, and why the work is split the way it is
 *
 * `resolveUser` runs *before* the user has touched their authenticator. It may only read: it
 * decides which identity the ceremony is for, and a ceremony that is then abandoned — the user
 * dismisses the platform prompt, which is a common and blameless thing to do — must leave the
 * invitation redeemable.
 *
 * `afterVerification` runs once the attestation has verified and *before* the plugin writes the
 * passkey row. That is the only correct place to spend the invitation: earlier and a failed
 * ceremony burns it, later and there is no way to refuse the write. Inside it the order is fixed
 * and load-bearing:
 *
 *   1. checks that must not consume anything (user verification, duplicate credential, the
 *      identity the context implies),
 *   2. `consumeInvitation` — a single conditional UPDATE, so two ceremonies racing one invitation
 *      have exactly one winner and the loser is refused before it creates anything,
 *   3. create the user, record the link, audit, open the session,
 *   4. return, and let the plugin store the credential.
 *
 * Throwing at any point in 1 aborts the ceremony with the invitation untouched. Throwing in 2's
 * losing branch does the same. Only a failure *after* step 2 can burn an invitation without
 * producing a user, and that is the deliberate trade: the alternative ordering — create the user
 * first — can produce two users from one invitation, which is unrecoverable.
 *
 * ## What this file compensates for in the plugin
 *
 *  - **`origin` is configured, never taken from the request.** The plugin falls back to
 *    `ctx.headers.get('origin')` when `origin` is unset, which would let the caller nominate the
 *    origin its own ceremony is checked against. `../config.ts` refuses to derive origins from a
 *    request for exactly this reason, so the configured list is passed explicitly.
 *  - **User verification is enforced here.** The plugin calls `verifyRegistrationResponse` and
 *    `verifyAuthenticationResponse` with `requireUserVerification: false`. AAT requires UV — a
 *    credential that only proves *presence* proves that someone touched the device, not that the
 *    owner did. `registrationInfo.userVerified` / `authenticationInfo.userVerified` carry the flag,
 *    so both seams re-impose the requirement rather than losing it.
 *  - **The ban check.** `POST /passkey/verify-authentication` creates a session without consulting
 *    `user.banned`; the authentication seam refuses first, so a banned user never gets a cookie.
 *  - **The last-passkey rule.** `POST /passkey/delete-passkey` will happily delete the only
 *    credential a user has. With no password and no email that is not a reversible mistake, so a
 *    `before` hook refuses it.
 */

import { ApiError, buildApiErrorPayload, ERROR_CODES, type ErrorCode } from '@aat/shared'
import { getAuthenticatorName, passkey } from '@better-auth/passkey'
import type { BetterAuthPlugin } from 'better-auth'
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { eq, sql } from 'drizzle-orm'
import * as z from 'zod'
import type { WorkerConfig } from '../config.ts'
import type { Database } from '../db/client.ts'
import { passkey as passkeyTable, user as userTable } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { writeAuditLog } from '../services/audit.ts'
import { clientAddress, consumeRateLimit, RATE_LIMITS, rateLimitKey } from '../services/rate-limit.ts'
import { syntheticEmail } from './identity.ts'
import {
  claimInvitation,
  consumeInvitation,
  recordInvitationUser,
  resolveRegistrationContext,
} from './invitations.ts'

export interface AatPasskeyOptions {
  db: Database
  config: WorkerConfig
}

/** Translate an AAT error code into the HTTP error Better Auth's router will serialise. */
function toApiError(code: ErrorCode, details?: Record<string, unknown>): APIError {
  const payload = buildApiErrorPayload(code, details === undefined ? {} : { details })
  return new APIError(payload.httpStatus as 400, { ...payload, message: payload.message })
}

function rethrow(error: unknown): never {
  if (error instanceof ApiError) throw toApiError(error.code, error.details)
  throw error
}

/**
 * Did this error come from AAT's own seams, or from inside the plugin?
 *
 * Both arrive as `APIError`; the difference is the `code`, which is one of the taxonomy's for
 * everything {@link toApiError} builds and one of `PASSKEY_ERROR_CODES` for everything the plugin
 * raises. That distinction is what stops the audit hooks from re-reporting a refusal the seam has
 * already described precisely.
 */
function isAatErrorPayload(body: unknown): boolean {
  const code = (body as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)
}

/** The paths the plugin serves, spelled once so the hooks below cannot drift from each other. */
const PATHS = {
  generateRegisterOptions: '/passkey/generate-register-options',
  verifyRegistration: '/passkey/verify-registration',
  generateAuthenticateOptions: '/passkey/generate-authenticate-options',
  verifyAuthentication: '/passkey/verify-authentication',
  deletePasskey: '/passkey/delete-passkey',
  updatePasskey: '/passkey/update-passkey',
} as const

/** A device label, not a document. Matches the bound on every other client string in this API. */
const MAX_PASSKEY_NAME_LENGTH = 120

/* ------------------------------------------------------------------------------------------- */
/* The official plugin, configured for AAT                                                      */
/* ------------------------------------------------------------------------------------------- */

export function aatPasskey({ db, config }: AatPasskeyOptions) {
  return passkey({
    rpID: config.rpId,
    rpName: config.rpName,
    // Explicit, and never `ctx.headers.get('origin')`. See the header comment.
    origin: [...config.trustedOrigins],
    authenticatorSelection: {
      // Discoverable credentials, so sign-in needs no username and the server never has to publish
      // which credentials exist for an account in order for one to be offered.
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    registration: {
      /**
       * Registration is reachable without a session, because the first thing an invited researcher
       * does is register — they have no session and no way to get one. A signed-in user adding a
       * second credential still takes the session path: the plugin prefers a live session and only
       * falls back to `resolveUser` when there is none.
       */
      requireSession: false,

      /**
       * Who is this ceremony for? Answered from the registration context alone, and only by
       * reading — see the header comment on why nothing is spent here.
       *
       * A registration invitation has no user yet, so an id is minted now and carried through the
       * plugin's verification row to `afterVerification`, which is what creates the row. A recovery
       * invitation names the user it is restoring access to, and returning that id is also what
       * makes the plugin populate `excludeCredentials` with the credentials that user already has,
       * so their authenticator does not silently mint a duplicate.
       */
      resolveUser: async ({ context }) => {
        if (!context) {
          throw toApiError('INVITE_INVALID', { reason: 'registration_context_required' })
        }
        const resolved = await resolveRegistrationContext(db, context).catch(rethrow)
        return {
          id: resolved.targetUserId ?? newId(),
          name: resolved.displayName,
          displayName: resolved.displayName,
        }
      },

      afterVerification: async ({ ctx, verification, user, context }) => {
        const headers = ctx.headers ?? new Headers()
        const now = new Date()

        const info = verification.verified ? verification.registrationInfo : undefined
        if (!info) {
          // Unreachable: the plugin checks `verified` before calling this. Asserting it anyway is
          // what keeps the user-verification check below from being silently skipped if that ever
          // changes.
          throw toApiError('INTERNAL', { reason: 'registration_not_verified' })
        }

        // The plugin verifies with `requireUserVerification: false`. AAT does not accept a
        // presence-only credential, so the flag is checked here instead. Refused as FORBIDDEN
        // rather than as an invitation error: the invitation is fine, the credential is not — and
        // this branch is also reached on the signed-in path, where there is no invitation at all.
        if (!info.userVerified) {
          throw toApiError('FORBIDDEN', { reason: 'user_verification_required' })
        }

        // One credential, one account. `passkey_credential_id_unique` would also stop this, but a
        // constraint violation is a 500; this is the same refusal with an answer a client can read.
        const [duplicate] = await db
          .select({ id: passkeyTable.id })
          .from(passkeyTable)
          .where(eq(passkeyTable.credentialID, info.credential.id))
          .limit(1)
        if (duplicate) {
          throw toApiError('FORBIDDEN', { reason: 'credential_already_registered' })
        }

        const label = getAuthenticatorName(info.aaguid)
        const named = (userId: string) => (label === undefined ? { userId } : { userId, name: label })

        if (!context) {
          /*
           * No registration context: a signed-in user adding another credential to their own
           * account. The plugin reached `resolveUser`'s alternative — a live session — so there is
           * no invitation to spend and no user to create.
           *
           * The session is re-checked rather than assumed. The plugin reads the session at
           * `generate-register-options` time and again at verification, but only refuses on a
           * *mismatch*: a session that expired between the two calls leaves the challenge cookie
           * as the sole credential. Requiring a live session closes that window.
           */
          const session = await getSessionFromCtx(ctx)
          if (!session) throw toApiError('AUTH_REQUIRED', { reason: 'session_required' })
          if (session.user.id !== user.id) {
            throw toApiError('FORBIDDEN', { reason: 'passkey_user_mismatch' })
          }
          if ((session.user as { banned?: boolean | null }).banned) {
            throw toApiError('FORBIDDEN', { reason: 'banned' })
          }

          await writeAuditLog(db, {
            actorUserId: session.user.id,
            action: 'passkey.register',
            targetType: 'user',
            targetId: session.user.id,
            headers,
          })
          return named(session.user.id)
        }

        const resolved = await resolveRegistrationContext(db, context, now).catch(rethrow)

        /*
         * The identity the context implies must be the identity the ceremony was started for.
         *
         * Without this, a caller holding a valid context could sign in as somebody else first, let
         * the plugin prefer that session, and reach here with a `user.id` the invitation never
         * named. The invitation would be spent against the wrong account. Both branches are pure
         * reads, so refusing costs the invitation nothing.
         */
        if (resolved.kind === 'recovery') {
          if (resolved.targetUserId === null || resolved.targetUserId !== user.id) {
            throw toApiError('RECOVERY_INVALID', { reason: 'registration_context_mismatch' })
          }
          const [target] = await db.select().from(userTable).where(eq(userTable.id, user.id)).limit(1)
          if (!target) throw toApiError('RECOVERY_INVALID', { reason: 'unknown_user' })
          if (target.banned) throw toApiError('FORBIDDEN', { reason: 'banned' })
        } else {
          const [clash] = await db
            .select({ id: userTable.id })
            .from(userTable)
            .where(eq(userTable.id, user.id))
            .limit(1)
          if (clash) throw toApiError('FORBIDDEN', { reason: 'registration_context_mismatch' })
        }

        /*
         * Spend the invitation BEFORE creating anything. If this fails, another ceremony has
         * already completed against the same invitation and no second user must appear. The
         * reverse order would leave a window in which a claim expires, the invitation returns to
         * `pending`, and a second user is created from one invitation.
         */
        const spent = await consumeInvitation(db, resolved.invitationId, context, now)
        if (!spent) throw toApiError('INVITE_USED')

        if (resolved.kind === 'registration') {
          await ctx.context.internalAdapter.createUser({
            id: user.id,
            name: resolved.displayName,
            // Synthetic and non-routable — see ./identity.ts. No real address is ever collected.
            email: syntheticEmail(user.id),
            emailVerified: false,
            role: resolved.role,
            banned: false,
          })
        }

        await recordInvitationUser(db, resolved.invitationId, user.id)

        const [account] = await db.select().from(userTable).where(eq(userTable.id, user.id)).limit(1)
        if (!account) {
          throw toApiError('INTERNAL', { reason: 'user_missing_after_registration' })
        }

        await writeAuditLog(db, {
          actorUserId: account.id,
          action: resolved.kind === 'recovery' ? 'passkey.recover' : 'user.register',
          targetType: 'user',
          targetId: account.id,
          details: { invitationId: resolved.invitationId, role: resolved.role },
          headers,
        })

        /*
         * `verify-registration` does not open a session — unlike `verify-authentication`, which
         * does. A researcher who has just proved possession of a credential minted under an
         * invitation only this deployment could issue is authenticated, and sending them to a
         * sign-in screen would be theatre. The session is issued through Better Auth's own
         * `setSessionCookie` so there is one cookie implementation in this system, not two.
         */
        const session = await ctx.context.internalAdapter.createSession(account.id)
        await setSessionCookie(ctx, { session, user: account })

        return named(account.id)
      },
    },

    authentication: {
      /**
       * Runs after the assertion verifies and before the plugin advances the counter and opens the
       * session. Everything refused here is refused before a cookie exists.
       */
      afterVerification: async ({ ctx, verification, clientData }) => {
        const headers = ctx.headers ?? new Headers()

        const [credential] = await db
          .select()
          .from(passkeyTable)
          .where(eq(passkeyTable.credentialID, clientData.id))
          .limit(1)
        if (!credential) {
          // The plugin looked the same row up a moment ago, so this is only reachable if it was
          // deleted mid-request. Refused rather than reasoned about.
          throw toApiError('AUTH_REQUIRED', { reason: 'unknown_credential' })
        }

        // As at registration: the plugin verifies with `requireUserVerification: false`.
        if (!verification.authenticationInfo.userVerified) {
          await writeAuditLog(db, {
            actorUserId: credential.userId,
            action: 'passkey.authenticate_failed',
            targetType: 'passkey',
            targetId: credential.id,
            details: { reason: 'user_verification_required' },
            headers,
          })
          throw toApiError('AUTH_REQUIRED', { reason: 'user_verification_required' })
        }

        const [account] = await db
          .select()
          .from(userTable)
          .where(eq(userTable.id, credential.userId))
          .limit(1)
        if (!account) throw toApiError('AUTH_REQUIRED', { reason: 'unknown_user' })
        if (account.banned) {
          await writeAuditLog(db, {
            actorUserId: account.id,
            action: 'passkey.authenticate_failed',
            targetType: 'passkey',
            targetId: credential.id,
            details: { reason: 'banned' },
            headers,
          })
          throw toApiError('FORBIDDEN', { reason: 'banned' })
        }

        // The plugin maintains `counter`; `last_used_at` is AAT's column and AAT's job. It is what
        // makes "this credential has not been used in a year" answerable on the management screen.
        await db
          .update(passkeyTable)
          .set({ lastUsedAt: new Date() })
          .where(eq(passkeyTable.id, credential.id))

        await writeAuditLog(db, {
          actorUserId: account.id,
          action: 'passkey.authenticate',
          targetType: 'passkey',
          targetId: credential.id,
          headers,
        })
      },
    },
  })
}

/* ------------------------------------------------------------------------------------------- */
/* AAT policy around the official plugin                                                        */
/* ------------------------------------------------------------------------------------------- */

/**
 * The AAT-owned half: the invitation endpoint, the rate limits on the credential paths, the
 * last-passkey rule, and the audit of failures the plugin swallows.
 *
 * This is a second plugin rather than more options on the first because none of it is WebAuthn.
 * Better Auth merges the endpoints and hooks of every plugin, so the split costs nothing at
 * runtime and keeps the boundary visible: anything in here would still make sense if the passkey
 * plugin were replaced tomorrow.
 */
export function aatPasskeyPolicy({ db }: AatPasskeyOptions) {
  return {
    id: 'aat-passkey-policy',
    endpoints: {
      /**
       * Exchange an invitation token for a registration context.
       *
       * The response is the only place the registration context ever appears in plaintext; only a
       * hash of it is stored. The client passes it straight to the plugin's
       * `generate-register-options?context=…`.
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

          let claimed: Awaited<ReturnType<typeof claimInvitation>>
          try {
            claimed = await claimInvitation(db, ctx.body.token, new Date())
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
            // Enough for the page to say who it is welcoming. Everything the ceremony itself needs
            // — challenge, RP, algorithms, excludeCredentials — comes from the plugin's own options
            // endpoint; repeating an RP ID here is how a second source of truth for one starts.
            displayName: claimed.displayName,
          })
        },
      ),
    },

    hooks: {
      before: [
        /**
         * Rate limits on the credential paths.
         *
         * Both halves of a ceremony are counted, not just the verify: issuing options writes a
         * verification row and sets a cookie, so an unlimited options endpoint is a cheap way to
         * make a database expensive. Keyed by client address, never by the secret being presented
         * — see ../services/rate-limit.ts.
         */
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === PATHS.generateRegisterOptions || ctx.path === PATHS.verifyRegistration,
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.headers ?? new Headers()
            await consumeRateLimit(
              db,
              rateLimitKey('passkeyRegister', clientAddress(headers)),
              RATE_LIMITS.passkeyRegister,
            ).catch(rethrow)
          }),
        },
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === PATHS.generateAuthenticateOptions || ctx.path === PATHS.verifyAuthentication,
          handler: createAuthMiddleware(async (ctx) => {
            const headers = ctx.headers ?? new Headers()
            await consumeRateLimit(
              db,
              rateLimitKey('passkeyAuthenticate', clientAddress(headers)),
              RATE_LIMITS.passkeyAuthenticate,
            ).catch(rethrow)
          }),
        },

        /**
         * Bound the one client-supplied string the plugin stores.
         *
         * `verify-registration` and `update-passkey` both accept a passkey `name` typed as an
         * unbounded `z.string()`. Every schema AAT writes carries a `.max()`, because a value that
         * is persisted and later rendered is a value whose size is the caller's choice unless
         * somebody says otherwise. The limit is generous — this is a human label for a device.
         */
        {
          matcher: (ctx: { path?: string }) =>
            ctx.path === PATHS.verifyRegistration || ctx.path === PATHS.updatePasskey,
          handler: createAuthMiddleware(async (ctx) => {
            const name = (ctx.body as { name?: unknown } | undefined)?.name
            if (typeof name === 'string' && name.length > MAX_PASSKEY_NAME_LENGTH) {
              throw toApiError('FORBIDDEN', { reason: 'passkey_name_too_long' })
            }
          }),
        },

        /**
         * A user may not delete their last passkey.
         *
         * With no password, no email and no social login, the last passkey *is* the account.
         * Removing it does not lock a user out temporarily; it destroys their access with no
         * self-service way back. The plugin's endpoint enforces ownership but not this, so the
         * rule is imposed before it runs. The same rule guards the administrative path in
         * ../routes/admin.ts and the self-service one in ../routes/me.ts — three doors, one policy.
         */
        {
          matcher: (ctx: { path?: string }) => ctx.path === PATHS.deletePasskey,
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { id?: unknown } | undefined
            const passkeyId = typeof body?.id === 'string' ? body.id : null
            if (!passkeyId) return

            const session = await getSessionFromCtx(ctx)
            // No session, or somebody else's credential: the plugin's own middleware answers those
            // cases, and answering them differently here would be a second authorization model.
            if (!session) return

            const [target] = await db
              .select({ userId: passkeyTable.userId })
              .from(passkeyTable)
              .where(eq(passkeyTable.id, passkeyId))
              .limit(1)
            if (!target || target.userId !== session.user.id) return

            const [counted] = await db
              .select({ count: sql<number>`count(*)` })
              .from(passkeyTable)
              .where(eq(passkeyTable.userId, target.userId))
            if ((counted?.count ?? 0) <= 1) {
              throw toApiError('FORBIDDEN', { reason: 'cannot_delete_last_passkey' })
            }
          }),
        },
      ],

      after: [
        /**
         * Audit the sign-in failures the plugin swallows.
         *
         * `after` hooks run on the failure path too — a thrown `APIError` is carried in
         * `ctx.context.returned` rather than propagated past them — which is the only place a
         * ceremony refused *inside* the plugin can still be recorded. A failed sign-in that leaves
         * no trace is a failed sign-in nobody can investigate.
         *
         * Failures the authentication seam itself raised are skipped: it has already written a row
         * naming the actual reason (a banned account, a missing user-verification flag), and a
         * second row saying "ceremony_failed" would only make the log less true.
         */
        {
          matcher: (ctx: { path?: string }) => ctx.path === PATHS.verifyAuthentication,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned
            if (!isAPIError(returned)) return
            if (isAatErrorPayload(returned.body)) return

            const headers = ctx.headers ?? new Headers()
            const response = (ctx.body as { response?: { id?: unknown } } | undefined)?.response
            const credentialId = typeof response?.id === 'string' ? response.id : null
            const [credential] = credentialId
              ? await db
                  .select({ id: passkeyTable.id, userId: passkeyTable.userId })
                  .from(passkeyTable)
                  .where(eq(passkeyTable.credentialID, credentialId))
                  .limit(1)
              : []

            await writeAuditLog(db, {
              actorUserId: credential?.userId ?? null,
              action: 'passkey.authenticate_failed',
              ...(credential ? { targetType: 'passkey', targetId: credential.id } : {}),
              details: { reason: credential ? 'ceremony_failed' : 'unknown_credential' },
              headers,
            })
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === PATHS.deletePasskey,
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return
            const session = await getSessionFromCtx(ctx)
            const passkeyId = (ctx.body as { id?: unknown } | undefined)?.id
            if (!session || typeof passkeyId !== 'string') return
            await writeAuditLog(db, {
              actorUserId: session.user.id,
              action: 'passkey.delete',
              targetType: 'passkey',
              targetId: passkeyId,
              headers: ctx.headers ?? new Headers(),
            })
          }),
        },
      ],
    },

    /**
     * A rejected ceremony is a client error, not a server one.
     *
     * The plugin wraps anything `@simplewebauthn/server` throws — a challenge that does not match,
     * an origin that is not ours, an attestation signed for another relying party — in
     * `INTERNAL_SERVER_ERROR`. Those are the *expected* answers on a credential endpoint: every one
     * of them is reachable by an attacker at will, so leaving them as 500s means an alerting
     * threshold that anybody on the internet can cross. The status is corrected on the way out; the
     * plugin's body is left exactly as it was, so nothing downstream has to know this happened.
     */
    async onResponse(response: Response) {
      if (response.status !== 500) return
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { code?: unknown } | null
      if (body?.code !== 'FAILED_TO_VERIFY_REGISTRATION') return
      return {
        response: new Response(response.body, {
          status: 400,
          statusText: 'Bad Request',
          headers: response.headers,
        }),
      }
    },
  } satisfies BetterAuthPlugin
}
