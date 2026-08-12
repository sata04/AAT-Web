/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Test client: a signed-in AAT user, obtained the way a real one is.
 *
 * There is no back door. Every session in these tests is produced by redeeming an invitation and
 * completing a real WebAuthn registration against the real endpoints, so the tests also constitute
 * an end-to-end exercise of the onboarding path. The only shortcut taken is creating the *first*
 * invitation directly through `createInvitation`, because in production that is done by an
 * administrator who, in a fresh deployment, does not yet exist.
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

/** Extract the session cookie(s) from a response, in a form suitable for a `Cookie` header. */
export function sessionCookie(response: Response): string {
  const cookies = response.headers.getSetCookie()
  return cookies
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((entry) => entry !== '')
    .join('; ')
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
  const redeem = await apiFetch('/api/auth/aat/invitation/redeem', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  if (redeem.status !== 200) {
    throw new Error(`invitation redeem failed: ${redeem.status} ${await redeem.text()}`)
  }
  const redeemed = (await redeem.json()) as {
    registrationContext: string
    options: { challenge: string; user: { id: string; displayName: string } }
  }

  const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
  const credential = await authenticator.register(redeemed.options.challenge)

  const registered = await apiFetch('/api/auth/aat/passkey/register', {
    method: 'POST',
    body: JSON.stringify({ registrationContext: redeemed.registrationContext, credential }),
  })
  if (registered.status !== 200) {
    throw new Error(`passkey registration failed: ${registered.status} ${await registered.text()}`)
  }
  const body = (await registered.json()) as { user: { id: string; displayName: string; role: Role } }

  return {
    userId: body.user.id,
    role: body.user.role,
    displayName: body.user.displayName,
    cookie: sessionCookie(registered),
    authenticator,
  }
}

/** The common case: invite a user with `role` and sign them in. */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  return registerWithToken(await issueInvitationToken(options))
}

/** Sign an existing user in again with their passkey, returning the new session cookie. */
export async function signIn(user: TestUser): Promise<string> {
  const options = await apiFetch('/api/auth/aat/passkey/authenticate/options', { method: 'POST' })
  const issued = (await options.json()) as { challengeId: string; options: { challenge: string } }
  const assertion = await user.authenticator.authenticate(issued.options.challenge)
  const verified = await apiFetch('/api/auth/aat/passkey/authenticate/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: issued.challengeId, credential: assertion }),
  })
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
