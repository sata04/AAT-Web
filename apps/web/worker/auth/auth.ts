/// <reference path="../../worker-configuration.d.ts" />

/**
 * The Better Auth instance.
 *
 * What is enabled: passkeys (via the plugin in ./passkey-plugin.ts) and the Admin plugin.
 * What is deliberately NOT enabled, and must stay that way:
 *
 *  - `emailAndPassword` — there is no password anywhere in this system.
 *  - social providers — no third party is in the trust path of a research dataset.
 *  - magic links / email OTP — there is no email address to send them to (see ./identity.ts).
 *  - open sign-up — the only way to become a user is to redeem an invitation.
 *
 * Trusted origins and the auth base URL come from configuration and are validated at startup;
 * neither is ever derived from the request. See ../config.ts for why that distinction is not
 * cosmetic.
 */

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins/admin'
import { resolveConfig } from '../config.ts'
import { getDatabase } from '../db/client.ts'
import * as schema from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import { aatPasskey } from './passkey-plugin.ts'

/** Sessions last two weeks and slide forward a day at a time while in use. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 14
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24

export type Auth = ReturnType<typeof buildAuth>

function buildAuth(env: Env) {
  const config = resolveConfig(env)
  const db = getDatabase(env)

  return betterAuth({
    appName: 'AAT',
    baseURL: config.authBaseUrl,
    secret: config.authSecret,
    // Everything under /api/* already routes to this Worker (wrangler.jsonc "run_worker_first"),
    // so the auth routes need no separate asset-routing rule.
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: { enabled: false },
    socialProviders: {},
    // No outbound telemetry from a Worker that holds research data.
    telemetry: { enabled: false },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    advanced: {
      database: {
        // ULIDs everywhere, including the rows Better Auth creates for itself, so there is one
        // identifier format in the system rather than two.
        generateId: () => newId(),
      },
    },
    plugins: [
      admin({
        // The Admin plugin's role string IS AAT's role; there is no second vocabulary to keep in
        // sync. Capabilities are derived from it at request time (see ../middleware/authorize.ts),
        // so the plugin's own permission statements are not configured — this Worker never asks it
        // "may this user do X", it asks the capability table.
        defaultRole: 'Viewer',
        adminRoles: ['Admin'],
      }),
      aatPasskey({ db, config }),
    ],
  })
}

const AUTH_CACHE = new WeakMap<Env, Auth>()

/** The auth instance for this `env`, built once per isolate. */
export function getAuth(env: Env): Auth {
  const cached = AUTH_CACHE.get(env)
  if (cached) return cached
  const auth = buildAuth(env)
  AUTH_CACHE.set(env, auth)
  return auth
}
