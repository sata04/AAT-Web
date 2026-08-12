/**
 * Identifier and secret-token generation.
 *
 * Two different things live here and they must not be confused:
 *
 *  - **Identifiers** (`newId`) are ULIDs. They are opaque to a client but are not secrets: they
 *    appear in URLs, logs and the audit trail. ULID rather than an auto-increment integer because
 *    a sequential id publishes how many users exist and turns an IDOR probe into counting; ULID
 *    rather than UUIDv4 because ULIDs sort by creation time, which several indexes rely on.
 *
 *  - **Secret tokens** (`newSecretToken`) are 256 bits of `crypto.getRandomValues`, base64url
 *    encoded. They are invitation tokens and registration contexts: they are bearer credentials,
 *    only ever stored hashed, and never logged.
 */

import { sha256Hex } from '@aat/shared'
import { ulid } from 'ulid'
import { bytesToBase64Url } from './encoding.ts'

/** A fresh opaque identifier. */
export function newId(): string {
  return ulid()
}

/** Bits of entropy in a secret token. 256 is the requirement, not a target to tune down. */
const SECRET_TOKEN_BYTES = 32

/**
 * Generate a 256-bit bearer token.
 *
 * The plaintext returned here is the only copy that will ever exist: callers show it to the user
 * once and store `hashToken()` of it. It must never be written to a log, an audit row, or an error
 * message.
 */
export function newSecretToken(): string {
  const bytes = new Uint8Array(SECRET_TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

/**
 * The stored form of a bearer token.
 *
 * Plain SHA-256 with no salt and no stretching is the right choice *here* and would be wrong for a
 * password: these tokens are 256 bits of uniform randomness, so there is no dictionary to run, no
 * guessing advantage to slow down, and no cross-user reuse for a salt to break up. What is needed
 * is a deterministic index — the redemption path looks a token up by its hash — and a
 * preimage-resistant one, which this is.
 */
export function hashToken(token: string): Promise<string> {
  return sha256Hex(token)
}
