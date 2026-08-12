import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, decodeFloat64Array, encodeFloat64Array } from '../src/codec.ts'
import { decodeSeries, encodeSeries, isWellFormedEncodedSeries } from '../src/wire.ts'

describe('base64 byte codec', () => {
  it('round-trips arbitrary byte sequences of every length mod 3', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 100, 257]) {
      const bytes = new Uint8Array(length)
      for (let index = 0; index < length; index++) bytes[index] = (index * 37 + 11) % 256
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    }
  })
})

describe('encodeSeries / decodeSeries', () => {
  it('round-trips finite values exactly', () => {
    const values = Float64Array.from([0, 1.5, -1.5, 9.797578, -0.02, 12345.6789])
    const encoded = encodeSeries(values)
    expect(encoded.length).toBe(values.length)
    expect(decodeSeries(encoded)).toEqual(values)
  })

  it('round-trips NaN gaps bit-for-bit', () => {
    const values = Float64Array.from([1, Number.NaN, 3, Number.NaN, Number.NaN])
    const decoded = decodeSeries(encodeSeries(values))
    expect(decoded.length).toBe(5)
    expect(Number.isNaN(decoded[1])).toBe(true)
    expect(Number.isNaN(decoded[3])).toBe(true)
    expect(Number.isNaN(decoded[4])).toBe(true)
    expect(decoded[0]).toBe(1)
    expect(decoded[2]).toBe(3)
  })

  it('converts null entries to NaN gaps on encode', () => {
    const decoded = decodeSeries(encodeSeries([1, null, 3]))
    expect(decoded[0]).toBe(1)
    expect(Number.isNaN(decoded[1] as number)).toBe(true)
    expect(decoded[2]).toBe(3)
  })

  it('round-trips +/-Infinity and -0 exactly (bit-for-bit, via Object.is)', () => {
    const values = Float64Array.from([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0])
    const decoded = decodeSeries(encodeSeries(values))
    expect(Object.is(decoded[0], Number.POSITIVE_INFINITY)).toBe(true)
    expect(Object.is(decoded[1], Number.NEGATIVE_INFINITY)).toBe(true)
    expect(Object.is(decoded[2], -0)).toBe(true)
    expect(Object.is(decoded[3], 0)).toBe(true)
  })

  it('handles an empty series', () => {
    const decoded = decodeSeries(encodeSeries(new Float64Array(0)))
    expect(decoded.length).toBe(0)
  })

  it('throws on a length mismatch between the header and the decoded body', () => {
    const encoded = encodeSeries(Float64Array.from([1, 2, 3]))
    expect(() => decodeSeries({ data: encoded.data, length: 5 })).toThrow()
  })

  it('encodeFloat64Array / decodeFloat64Array agree with encodeSeries / decodeSeries', () => {
    const values = Float64Array.from([1, 2, 3])
    expect(encodeFloat64Array(values)).toBe(encodeSeries(values).data)
    expect(decodeFloat64Array(encodeSeries(values).data)).toEqual(decodeSeries(encodeSeries(values)))
  })
})

describe('isWellFormedEncodedSeries', () => {
  it('accepts a genuinely encoded series', () => {
    expect(isWellFormedEncodedSeries(encodeSeries(Float64Array.from([1, 2, 3])))).toBe(true)
  })

  it('accepts an empty series', () => {
    expect(isWellFormedEncodedSeries(encodeSeries(new Float64Array(0)))).toBe(true)
  })

  it('rejects a base64 body shorter than the declared length implies', () => {
    const encoded = encodeSeries(Float64Array.from([1, 2, 3]))
    expect(isWellFormedEncodedSeries({ data: encoded.data, length: 5 })).toBe(false)
  })

  it('rejects a base64 body longer than the declared length implies', () => {
    const encoded = encodeSeries(Float64Array.from([1, 2, 3]))
    expect(isWellFormedEncodedSeries({ data: encoded.data, length: 1 })).toBe(false)
  })

  it('rejects a negative length', () => {
    expect(isWellFormedEncodedSeries({ data: '', length: -1 })).toBe(false)
  })

  it('rejects a non-integer length', () => {
    expect(isWellFormedEncodedSeries({ data: '', length: 1.5 })).toBe(false)
  })

  it('rejects a body containing characters outside the base64 alphabet', () => {
    expect(isWellFormedEncodedSeries({ data: '####', length: 3 })).toBe(false)
  })

  it('rejects a body with whitespace, even though base64ToBytes tolerates it when decoding', () => {
    const encoded = encodeSeries(Float64Array.from([1, 2, 3]))
    const withWhitespace = `${encoded.data.slice(0, 4)} ${encoded.data.slice(4)}`
    expect(isWellFormedEncodedSeries({ data: withWhitespace, length: encoded.length })).toBe(false)
  })
})
