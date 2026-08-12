/**
 * Byte encodings the Worker needs that @aat/shared does not provide.
 *
 * @aat/shared's `bytesToBase64` / `base64ToBytes` implement standard (RFC 4648 §4) base64 and are
 * reused here rather than reimplemented. WebAuthn, however, speaks base64url (§5) throughout —
 * challenges, credential ids, signatures — so the two alphabets are translated at the boundary.
 * That translation is not optional: `base64ToBytes` skips characters outside the standard
 * alphabet, so feeding it a base64url string would silently *drop* every '-' and '_' and decode to
 * the wrong bytes rather than failing.
 */

import { base64ToBytes, bytesToBase64 } from '@aat/shared'

/** Encode bytes as unpadded base64url, the encoding WebAuthn uses on the wire. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode unpadded or padded base64url. Throws if the input contains characters outside the alphabet. */
export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) {
    throw new Error('Value is not valid base64url')
  }
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/'))
}

/** Constant-time comparison of two byte sequences. Used wherever a secret is compared. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= (a[index] as number) ^ (b[index] as number)
  }
  return difference === 0
}

/** Concatenate byte sequences into one buffer. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const HEX_CHARS = '0123456789abcdef'

/** Lowercase hex of raw bytes. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number
    hex += HEX_CHARS.charAt(byte >> 4) + HEX_CHARS.charAt(byte & 0x0f)
  }
  return hex
}
