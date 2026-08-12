/**
 * Binary <-> JSON-safe string codecs used by the analysis snapshot format (`snapshot.ts`).
 *
 * Plain JSON cannot carry raw bytes, so numeric series are encoded as base64 of a little-endian
 * Float64Array. This is exact (every IEEE-754 bit pattern round-trips, including NaN, +/-Infinity
 * and -0 — see `docs` on the snapshot format) and far more compact than a JSON number array.
 *
 * The base64 codec is hand-rolled rather than built on `btoa`/`atob` because those operate on
 * JS "binary strings" one UTF-16 code unit per byte; converting a large Float64Array to such a
 * string with `String.fromCharCode(...bytes)` risks blowing the engine's call-stack argument
 * limit on multi-megabyte series, which a drop-tower run's full-resolution channel easily is.
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

/**
 * Encode a Float64Array as base64 of its little-endian byte representation.
 *
 * Encoding is explicit byte-by-byte via `DataView.setFloat64(..., true)` rather than reading
 * `Float64Array.buffer` directly, so the result is little-endian regardless of host endianness
 * (in practice always true for JS engines today, but the snapshot format documents an explicit
 * wire format and should not silently depend on that happening to hold).
 */
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
