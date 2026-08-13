/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Test client: a signed-in AAT user, obtained the way a real one is.
 *
 * There is no back door. Every session in these tests is produced by redeeming an invitation and
 * completing a real WebAuthn registration against the real endpoints, so the tests also constitute
 * an end-to-end exercise of the onboarding path. The only shortcut taken is creating the *first*
 * invitation directly through `createInvitation`, because in production that is done by an
 * administrator who, in a fresh deployment, does not yet exist.
 *
 * A passkey ceremony is two requests, and the second one only works because it carries the signed
 * challenge cookie the first one set. That cookie *is* the link between the challenge the server
 * issued and the response it is asked to verify, so the helpers below thread it through
 * explicitly rather than hiding it: a test that forgets it is testing a different thing.
 */

import { env, SELF } from 'cloudflare:test'
import type { Role } from '@aat/shared'
import { createInvitation } from '../../../worker/auth/invitations.ts'
import { getDatabase } from '../../../worker/db/client.ts'
import { VirtualAuthenticator } from './authenticator.ts'

export const ORIGIN = 'https://aat.test'
export const RP_ID = 'aat.test'

export function db() {
  return getDatabase(env)
}

/** Fetch against the Worker under test, with the Origin header Better Auth's CSRF check requires. */
export async function apiFetch(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('origin', ORIGIN)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers })
}

export interface TestUser {
  userId: string
  role: Role
  cookie: string
  authenticator: VirtualAuthenticator
  displayName: string
}

/** Extract the cookie(s) a response set, in a form suitable for a `Cookie` header. */
export function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie()
  return cookies
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry !== '')
    .join('; ')
}

export interface RegistrationCeremony {
  /** The `Cookie` header value carrying the plugin's signed challenge cookie. */
  cookie: string
  challenge: string
  excludeCredentials: { id: string }[]
}

/**
 * Ask the passkey plugin for registration options.
 *
 * `context` is AAT's registration context; without a session it is the only thing that tells
 * `resolveUser` who the ceremony is for. Omitting it is the signed-in path — a user adding a
 * second credential — in which case `cookie` must carry their session.
 */
export async function registrationOptions(
  options: { context?: string; cookie?: string } = {},
): Promise<RegistrationCeremony> {
  const query = options.context ? `?context=${encodeURIComponent(options.context)}` : ''
  const response = await apiFetch(`/api/auth/passkey/generate-register-options${query}`, {
    ...(options.cookie ? { cookie: options.cookie } : {}),
  })
  if (response.status !== 200) {
    throw new Error(`registration options failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as {
    challenge: string
    excludeCredentials?: { id: string }[]
  }
  const challengeCookie = sessionCookie(response)
  return {
    cookie: options.cookie ? `${options.cookie}; ${challengeCookie}` : challengeCookie,
    challenge: body.challenge,
    excludeCredentials: body.excludeCredentials ?? [],
  }
}

/** Complete a registration ceremony. The caller owns the outcome, including a failure. */
export async function verifyRegistration(ceremony: { cookie: string }, response: unknown): Promise<Response> {
  return apiFetch('/api/auth/passkey/verify-registration', {
    method: 'POST',
    cookie: ceremony.cookie,
    body: JSON.stringify({ response }),
  })
}

/** Redeem an invitation token for a registration context. */
export async function redeemInvitation(token: string): Promise<Response> {
  return apiFetch('/api/auth/aat/invitation/redeem', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export interface CreateUserOptions {
  role?: Role
  displayName?: string
  ttlSeconds?: number
}

/** Issue an invitation directly (bootstrap path) and return its plaintext token. */
export async function issueInvitationToken(options: CreateUserOptions = {}): Promise<string> {
  const invitation = await createInvitation(db(), {
    kind: 'registration',
    role: options.role ?? 'Researcher',
    displayName: options.displayName ?? 'テスト研究者',
    ttlSeconds: options.ttlSeconds ?? 3600,
    // No creator: in a fresh deployment the first invitation predates the first administrator.
    createdByUserId: null,
  })
  return invitation.token
}

/** Redeem a token and complete a passkey registration, returning a signed-in user. */
export async function registerWithToken(token: string): Promise<TestUser> {
  const redeem = await redeemInvitation(token)
  if (redeem.status !== 200) {
    throw new Error(`invitation redeem failed: ${redeem.status} ${await redeem.text()}`)
  }
  const redeemed = (await redeem.json()) as { registrationContext: string }

  const ceremony = await registrationOptions({ context: redeemed.registrationContext })
  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
  const registered = await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))
  if (registered.status !== 200) {
    throw new Error(`passkey registration failed: ${registered.status} ${await registered.text()}`)
  }

  // `verify-registration` answers with the passkey row; the session it opened is in the cookie.
  // Reading the identity back through the ordinary API is also the assertion that the cookie works.
  const cookie = sessionCookie(registered)
  return { ...(await identify(cookie)), cookie, authenticator }
}

/** Who does this session belong to? Asked the way any client would ask. */
async function identify(cookie: string): Promise<Omit<TestUser, 'cookie' | 'authenticator'>> {
  const me = await apiFetch('/api/v1/me', { cookie })
  if (me.status !== 200) {
    throw new Error(`session did not authenticate: ${me.status} ${await me.text()}`)
  }
  const body = (await me.json()) as { user: { id: string; displayName: string; role: Role } }
  return { userId: body.user.id, role: body.user.role, displayName: body.user.displayName }
}

/** The common case: invite a user with `role` and sign them in. */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  return registerWithToken(await issueInvitationToken(options))
}

export interface AuthenticationCeremony {
  cookie: string
  challenge: string
  allowCredentials: { id: string }[]
}

/** Ask the passkey plugin for authentication options, anonymously unless a cookie is supplied. */
export async function authenticationOptions(
  options: { cookie?: string } = {},
): Promise<AuthenticationCeremony> {
  const response = await apiFetch('/api/auth/passkey/generate-authenticate-options', {
    ...(options.cookie ? { cookie: options.cookie } : {}),
  })
  if (response.status !== 200) {
    throw new Error(`authentication options failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { challenge: string; allowCredentials?: { id: string }[] }
  return {
    cookie: sessionCookie(response),
    challenge: body.challenge,
    allowCredentials: body.allowCredentials ?? [],
  }
}

/** Complete an authentication ceremony. The caller owns the outcome, including a failure. */
export async function verifyAuthentication(
  ceremony: { cookie: string },
  response: unknown,
): Promise<Response> {
  return apiFetch('/api/auth/passkey/verify-authentication', {
    method: 'POST',
    cookie: ceremony.cookie,
    body: JSON.stringify({ response }),
  })
}

/** Sign an existing user in again with their passkey, returning the new session cookie. */
export async function signIn(user: TestUser): Promise<string> {
  const ceremony = await authenticationOptions()
  const assertion = await user.authenticator.authenticate(ceremony.challenge)
  const verified = await verifyAuthentication(ceremony, assertion)
  if (verified.status !== 200) {
    throw new Error(`sign-in failed: ${verified.status} ${await verified.text()}`)
  }
  return sessionCookie(verified)
}

/** Create a run owned by `user`. */
export async function createRun(user: TestUser, filename = '260811a_data.csv'): Promise<string> {
  const response = await apiFetch('/api/v1/runs', {
    method: 'POST',
    cookie: user.cookie,
    body: JSON.stringify({ originalFilename: filename }),
  })
  if (response.status !== 201) {
    throw new Error(`run creation failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { run: { id: string } }
  return body.run.id
}

const SOURCE_SHA = 'a'.repeat(64)

/** Create an immutable revision of `runId`, with a config hash the caller can vary. */
export async function createRevision(
  user: TestUser,
  runId: string,
  overrides: { configHash?: string; sourceSha256?: string } = {},
): Promise<string> {
  const response = await apiFetch(`/api/v1/runs/${runId}/revisions`, {
    method: 'POST',
    cookie: user.cookie,
    body: JSON.stringify({
      sourceSha256: overrides.sourceSha256 ?? SOURCE_SHA,
      configHash: overrides.configHash ?? 'b'.repeat(64),
      config: {},
      engineVersion: '1.0.0',
      snapshotFormatVersion: 1,
      metrics: {
        windowSize: 0.1,
        inner: { mean: 0.0001, std: 0.00002, startTime: 1.2 },
        drag: { mean: 'NaN', std: null, startTime: null },
        innerSampleCount: 1450,
        dragSampleCount: 0,
        warningCount: 0,
      },
    }),
  })
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`revision creation failed: ${response.status} ${await response.text()}`)
  }
  const body = (await response.json()) as { revision: { id: string } }
  return body.revision.id
}

/** A minimal but valid poster plot spec for `revisionId`. */
export function posterSpec(revisionId: string, kind: 'auto' | 'custom' = 'auto') {
  const time = new Float64Array([0, 0.001, 0.002, 0.003])
  const values = new Float64Array([0.0001, 0.0002, 0.00015, 0.0001])
  return {
    analysisRevisionId: revisionId,
    runCode: '260811a',
    posterKind: kind,
    posterPresetVersion: 'aat-poster-v1',
    xMin: 0,
    xMax: 1.45,
    series: 'inner',
    title: 'テスト',
    showLegend: true,
    figureWidth: 10.6,
    figureHeight: 3.4,
    dpi: 300,
    data: {
      inner: { time: encodeFloat64(time), values: encodeFloat64(values) },
    },
  }
}

function encodeFloat64(values: Float64Array): { data: string; length: number } {
  const buffer = new ArrayBuffer(values.length * 8)
  const view = new DataView(buffer)
  for (let index = 0; index < values.length; index++) {
    view.setFloat64(index * 8, values[index] as number, true)
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { data: btoa(binary), length: values.length }
}
