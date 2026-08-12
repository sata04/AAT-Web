/**
 * SHA-256 hashing built on Web Crypto (`crypto.subtle`), which is available both in browsers and
 * in the Cloudflare Worker runtime — unlike Node's `node:crypto`, it needs no polyfill on either
 * side of this monorepo. Every hash produced here is lowercase hex, matching the convention used
 * throughout the golden fixtures (see `tests/golden/index.json`'s `csvSha256`).
 */

const HEX_CHARS = '0123456789abcdef'

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number
    hex += HEX_CHARS.charAt(byte >> 4) + HEX_CHARS.charAt(byte & 0x0f)
  }
  return hex
}

/** SHA-256 of a UTF-8 string or raw bytes, returned as lowercase hex. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  // SubtleCrypto.digest() respects a view's byteOffset/byteLength, so a subarray view into a
  // larger buffer is hashed correctly without an extra copy. The cast works around lib.dom.d.ts
  // typing Uint8Array's buffer as `ArrayBufferLike` (which includes SharedArrayBuffer) while
  // BufferSource requires a plain ArrayBuffer; a Uint8Array is never actually backed by one here.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}
