/**
 * The Better Auth browser client.
 *
 * One instance for the whole application, built here rather than per screen: the
 * client owns nanostores atoms (the passkey list, the session signal) and two of
 * them would not see each other's invalidations, so "add a passkey" on one
 * screen would leave a stale list on another.
 *
 * It is also created lazily, on first use, rather than at module import. The
 * client installs a session-refresh manager — focus/online/broadcast listeners
 * and optional polling — so constructing it eagerly would make a build with the
 * cloud compiled out (`src/cloud/enabled.ts`) pay for listeners that can only
 * ever watch a session that does not exist. Every caller sits behind a screen
 * or callback that is unreachable in that build, which is what makes lazy
 * construction equivalent to never constructing it.
 *
 * `basePath` matches `worker/auth/auth.ts` exactly. It is written out rather
 * than defaulted because the Worker mounts Better Auth under `/api/auth` and
 * every request in this application is same-origin — there is no `baseURL`, so
 * the client never has an absolute origin it could get wrong.
 *
 * Only the passkey plugin is installed. There is no password, no email, no
 * social provider and no magic link anywhere in AAT (see
 * `worker/auth/identity.ts` for why there is not even a real address), so the
 * client surface is deliberately tiny: `signIn.passkey`, `passkey.addPasskey`,
 * the passkey management endpoints, and Better Auth's own session endpoints.
 */

import { passkeyClient } from '@better-auth/passkey/client'
import { createAuthClient } from 'better-auth/client'

function buildClient() {
  return createAuthClient({
    basePath: '/api/auth',
    plugins: [passkeyClient()],
  })
}

export type AuthClient = ReturnType<typeof buildClient>

let client: AuthClient | null = null

/** The one auth client, constructed the first time anything actually calls it. */
export function getAuthClient(): AuthClient {
  if (client === null) client = buildClient()
  return client
}
