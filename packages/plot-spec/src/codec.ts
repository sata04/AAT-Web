/**
 * Low-level byte codecs used by the poster plot spec's wire format.
 *
 * This package cannot depend on `@aat/shared` (see the package's task scope), so the base64 <->
 * bytes and Float64Array <-> base64 codecs are reimplemented here rather than imported. They are
 * intentionally the same algorithms `@aat/shared`'s `binary.ts` uses elsewhere in this monorepo,
 * for the same reasons:
 *
 *  - The base64 codec is hand-rolled instead of built on `btoa`/`atob`, which operate on JS
 *    "binary strings" one UTF-16 code unit per byte; converting a large Float64Array to such a
 *    string via `String.fromCharCode(...bytes)` risks blowing the engine's call-stack argument
 *    limit on multi-megabyte series.
 *  - Float64 bytes are written/read explicitly via `DataView` in little-endian order, so the wire
 *    format does not silently depend on host endianness (every engine in practice is
 *    little-endian today, but the format is documented and enforced regardless).
 *  - Every IEEE-754 bit pattern round-trips exactly, including NaN, +/-Infinity and -0 — which is
 *    exactly why NaN can carry the "gap" meaning described in `spec.ts`.
 */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Encode raw bytes as standard (RFC 4648) base64, with '=' padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = ''
  const length = bytes.length
  for (let index = 0; index < length; index += 3) {
    const byte0 = bytes[index] as number
    const hasByte1 = index + 1 < length
    const hasByte2 = index + 2 < length
    const byte1 = hasByte1 ? (bytes[index + 1] as number) : 0
    const byte2 = hasByte2 ? (bytes[index + 2] as number) : 0

    result += BASE64_CHARS.charAt(byte0 >> 2)
    result += BASE64_CHARS.charAt(((byte0 & 0x03) << 4) | (byte1 >> 4))
    result += hasByte1 ? BASE64_CHARS.charAt(((byte1 & 0x0f) << 2) | (byte2 >> 6)) : '='
    result += hasByte2 ? BASE64_CHARS.charAt(byte2 & 0x3f) : '='
  }
  return result
}

function buildBase64Lookup(): Int16Array {
  const table = new Int16Array(256).fill(-1)
  for (let index = 0; index < BASE64_CHARS.length; index++) {
    table[BASE64_CHARS.charCodeAt(index)] = index
  }
  return table
}

const BASE64_LOOKUP = buildBase64Lookup()

/** Standard base64 alphabet with optional '=' padding, and nothing else (no whitespace tolerated). */
export const STRICT_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Decode standard base64 (padding, whitespace and unknown characters are tolerated/ignored). */
export function base64ToBytes(base64: string): Uint8Array {
  // Two full bytes come out of every 3 six-bit groups that carry data; this over-allocates by at
  // most 2 bytes when padding characters are present and is trimmed back at the end.
  const bytes = new Uint8Array(Math.ceil((base64.length * 6) / 8))
  let bitBuffer = 0
  let bitCount = 0
  let byteIndex = 0

  for (let index = 0; index < base64.length; index++) {
    const code = base64.charCodeAt(index)
    const value = code < 256 ? (BASE64_LOOKUP[code] as number) : -1
    if (value < 0) continue // padding ('='), whitespace, or any other non-alphabet character

    bitBuffer = (bitBuffer << 6) | value
    bitCount += 6
    if (bitCount >= 8) {
      bitCount -= 8
      bytes[byteIndex++] = (bitBuffer >> bitCount) & 0xff
    }
  }

  return bytes.subarray(0, byteIndex)
}

/** Encode a Float64Array as base64 of its little-endian byte representation. */
export function encodeFloat64Array(values: Float64Array): string {
  const buffer = new ArrayBuffer(values.length * 8)
  const view = new DataView(buffer)
  for (let index = 0; index < values.length; index++) {
    view.setFloat64(index * 8, values[index] as number, true)
  }
  return bytesToBase64(new Uint8Array(buffer))
}

/** Inverse of {@link encodeFloat64Array}. Throws if the decoded byte length is not a multiple of 8. */
export function decodeFloat64Array(base64: string): Float64Array {
  const bytes = base64ToBytes(base64)
  if (bytes.length % 8 !== 0) {
    throw new Error(
      `Invalid Float64Array encoding: decoded ${bytes.length} bytes, which is not a multiple of 8`,
    )
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const result = new Float64Array(bytes.length / 8)
  for (let index = 0; index < result.length; index++) {
    result[index] = view.getFloat64(index * 8, true)
  }
  return result
}

/** The exact base64 string length standard (padded) base64 produces for `byteLength` bytes. */
export function expectedBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

const HEX_CHARS = '0123456789abcdef'

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] as number
    hex += HEX_CHARS.charAt(byte >> 4) + HEX_CHARS.charAt(byte & 0x0f)
  }
  return hex
}

/**
 * SHA-256 of a UTF-8 string, returned as lowercase hex. Built on Web Crypto (`crypto.subtle`),
 * available both in browsers and in the Cloudflare Worker runtime that will validate these specs.
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest))
}

/**
 * Deterministically stringify a JSON-compatible value with object keys sorted recursively, so
 * that two values which are deep-equal (regardless of the key insertion order either happened to
 * be built with) always serialise identically. Array element order is preserved — it is
 * significant. Used as the canonical form hashed by `specHash` / preset content hashes.
 *
 * Only plain JSON shapes are supported: objects, arrays, strings, finite numbers, booleans and
 * null. `undefined` object values are dropped, matching `JSON.stringify`'s own behaviour, and are
 * rejected on arrays/top level the same way `JSON.stringify` rejects them (by throwing is avoided
 * here — the schema layer never lets `undefined`, `NaN` or `Infinity` reach this function).
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalStringify cannot encode non-finite number: ${value}`)
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    return `{${entries.join(',')}}`
  }
  throw new Error(`canonicalStringify cannot encode value of type ${typeof value}`)
}
