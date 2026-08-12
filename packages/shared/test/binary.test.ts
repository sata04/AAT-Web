import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, decodeFloat64Array, encodeFloat64Array } from '../src/binary.ts'
import { gzipCompress, gzipDecompress } from '../src/gzip.ts'

describe('base64 codec', () => {
  it.each([0, 1, 2, 3, 4, 5, 8, 100, 1000])('round-trips %d random bytes', (length) => {
    const bytes = new Uint8Array(length)
    for (let i = 0; i < length; i++) bytes[i] = (i * 37 + 11) % 256
    const decoded = base64ToBytes(bytesToBase64(bytes))
    expect(decoded).toEqual(bytes)
  })

  it('produces standard, padded base64', () => {
    const bytes = new TextEncoder().encode('AAT')
    expect(bytesToBase64(bytes)).toBe('QUFU')
  })
})

describe('Float64Array codec', () => {
  it('round-trips ordinary finite values', () => {
    const values = new Float64Array([0, 1, -1, 12345.6789012345, -1e300, 1e-300])
    const decoded = decodeFloat64Array(encodeFloat64Array(values))
    expect(decoded).toEqual(values)
  })

  it('round-trips NaN, +Infinity, -Infinity and -0 bit-exactly', () => {
    const values = new Float64Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0])
    const decoded = decodeFloat64Array(encodeFloat64Array(values))

    expect(Number.isNaN(decoded[0])).toBe(true)
    expect(decoded[1]).toBe(Number.POSITIVE_INFINITY)
    expect(decoded[2]).toBe(Number.NEGATIVE_INFINITY)
    expect(Object.is(decoded[3], -0)).toBe(true)
    expect(Object.is(decoded[4], -0)).toBe(false) // 0, not -0 - distinguishing the two is the point

    // Compare raw bits directly, the strongest possible notion of "exact".
    const originalBits = new BigInt64Array(values.buffer)
    const decodedBits = new BigInt64Array(decoded.buffer)
    expect(decodedBits).toEqual(originalBits)
  })

  it('encodes as little-endian regardless of host endianness', () => {
    // 1.0 as float64 is 0x3FF0000000000000 big-endian, so little-endian bytes end with 0x3F 0xF0.
    const encoded = encodeFloat64Array(new Float64Array([1.0]))
    const bytes = base64ToBytes(encoded)
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f])
  })

  it('rejects a byte length that is not a multiple of 8', () => {
    expect(() => decodeFloat64Array(bytesToBase64(new Uint8Array(7)))).toThrow()
  })

  it('round-trips an empty series', () => {
    expect(decodeFloat64Array(encodeFloat64Array(new Float64Array(0)))).toEqual(new Float64Array(0))
  })
})

describe('gzip round trip', () => {
  it('compresses and decompresses back to the original bytes', async () => {
    const original = new TextEncoder().encode('a'.repeat(10_000) + JSON.stringify({ hello: 'world' }))
    const compressed = await gzipCompress(original)
    expect(compressed.length).toBeLessThan(original.length) // highly repetitive input compresses well
    const decompressed = await gzipDecompress(compressed)
    expect(decompressed).toEqual(original)
  })

  it('round-trips an empty payload', async () => {
    const compressed = await gzipCompress(new Uint8Array(0))
    const decompressed = await gzipDecompress(compressed)
    expect(decompressed).toEqual(new Uint8Array(0))
  })

  it('round-trips binary data containing every byte value', async () => {
    const original = new Uint8Array(256)
    for (let i = 0; i < 256; i++) original[i] = i
    const decompressed = await gzipDecompress(await gzipCompress(original))
    expect(decompressed).toEqual(original)
  })
})
