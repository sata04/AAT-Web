/**
 * Byte encodings the Worker needs that @aat/shared does not provide.
 *
 * @aat/shared's `bytesToBase64` implements standard (RFC 4648 §4) base64 and is reused here rather
 * than reimplemented. Secret tokens are handed out in URLs, so they are re-encoded into base64url
 * (§5), whose alphabet has no '+' or '/' to be mangled by a query-string parser and no '=' to be
 * percent-encoded.
 *
 * This module used to carry the byte plumbing of a hand-written WebAuthn implementation — a
 * base64url decoder, a constant-time comparison, a hex encoder. All of that now lives in
 * `@simplewebauthn/server`, reached through the official passkey plugin, and what is left is the
 * one function ../lib/ids.ts needs.
 */

import { bytesToBase64 } from '@aat/shared'

/** Encode bytes as unpadded base64url — the form a token can be pasted into a URL in. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
