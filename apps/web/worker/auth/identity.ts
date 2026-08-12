/**
 * User identity in a system that collects no email address.
 *
 * Better Auth's user model requires a unique `email`. AAT has no email concept: registration is by
 * invitation, sign-in is by passkey, and there is no address to send anything to. The requirement
 * is not that the column disappear — it is that no *real* address is ever collected, displayed or
 * used. So every user is given a synthetic, non-routable address derived from their opaque id.
 *
 * `.invalid` is reserved by RFC 2606 specifically so that it can never be delegated or resolved.
 * An address in it cannot receive mail even by accident, which is the property that matters: a
 * future bug that tries to send something has nowhere to send it.
 *
 * Two things this module deliberately does NOT do:
 *  - invent a random password to satisfy an API. There is no credential provider enabled, so there
 *    is no password to store, and a password nobody knows is still a password an attacker can
 *    attack.
 *  - use the Admin plugin's `createUser`, which requires email, password and name from the caller
 *    and is therefore an onboarding path that would reintroduce exactly what this design removes.
 */

/** Domain for synthetic addresses. RFC 2606 reserved — never resolvable, never routable. */
export const SYNTHETIC_EMAIL_DOMAIN = 'aat.invalid'

/** The synthetic address for a user id. Deterministic, so it can be recomputed rather than stored twice. */
export function syntheticEmail(userId: string): string {
  return `${userId.toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}`
}

/** True for an address this system generated. Used to assert that no real address ever leaked in. */
export function isSyntheticEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`@${SYNTHETIC_EMAIL_DOMAIN}`)
}

/**
 * The public shape of a user, as every API response renders it.
 *
 * `email` is absent by construction: it is an artefact of the auth framework's data model, not an
 * identity, and putting it in a response would make it one. `displayName` is what a human sees.
 */
export interface PublicUser {
  id: string
  displayName: string
  role: string
  banned: boolean
  createdAt: string
}

export function toPublicUser(row: {
  id: string
  name: string
  role: string
  banned: boolean | null
  createdAt: Date
}): PublicUser {
  return {
    id: row.id,
    displayName: row.name,
    role: row.role,
    banned: row.banned ?? false,
    createdAt: row.createdAt.toISOString(),
  }
}
