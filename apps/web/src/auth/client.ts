/**
 * The Better Auth browser client.
 *
 * One instance for the whole application, built here rather than per screen: the
 * client owns nanostores atoms (the passkey list, the session signal) and two of
 * them would not see each other's invalidations, so "add a passkey" on one
 * screen would leave a stale list on another.
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

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [passkeyClient()],
})
