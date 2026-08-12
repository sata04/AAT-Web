/**
 * A minimal CBOR (RFC 8949) decoder, sufficient for WebAuthn.
 *
 * WebAuthn hands the server two CBOR documents: the attestation object wrapping the authenticator
 * data, and the COSE-encoded credential public key inside it. Decoding them needs unsigned and
 * negative integers (COSE labels are negative), byte strings, text strings, arrays, maps and the
 * simple values — and nothing else.
 *
 * Why hand-written rather than a dependency: this is the entire CBOR surface WebAuthn uses, the
 * code is ~150 lines, and every additional package on the auth path is a package that can be
 * compromised into the one part of the system that must not be. See docs/supply-chain.md.
 *
 * Deliberate restrictions, each of which is a security property rather than a missing feature:
 *  - **Definite lengths only.** CTAP2 mandates canonical CBOR, so an indefinite-length item in an
 *    attestation object is a malformed input, not a compatibility case to accommodate.
 *  - **No trailing data.** {@link decodeCbor} rejects bytes after the top-level item, so an
 *    attacker cannot append a second document that a different parser might read instead.
 *  - **Positions are returned**, because parsing authenticator data requires knowing exactly where
 *    the credential public key ended and the optional extension block begins.
 */

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | CborMap

/** CBOR maps may key on integers (COSE does) as well as strings, so a `Map` is the honest model. */
export type CborMap = Map<string | number | bigint, CborValue>

interface DecodeResult {
  value: CborValue
  offset: number
}

class CborReader {
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private require(offset: number, length: number): void {
    if (offset + length > this.bytes.length) {
      throw new Error('CBOR input ended unexpectedly')
    }
  }

  /** Read a major type's argument, returning the value and the offset just past it. */
  private readArgument(offset: number): { argument: number | bigint; offset: number } {
    const initial = this.bytes[offset] as number
    const additional = initial & 0x1f
    if (additional < 24) return { argument: additional, offset: offset + 1 }
    if (additional === 24) {
      this.require(offset + 1, 1)
      return { argument: this.view.getUint8(offset + 1), offset: offset + 2 }
    }
    if (additional === 25) {
      this.require(offset + 1, 2)
      return { argument: this.view.getUint16(offset + 1, false), offset: offset + 3 }
    }
    if (additional === 26) {
      this.require(offset + 1, 4)
      return { argument: this.view.getUint32(offset + 1, false), offset: offset + 5 }
    }
    if (additional === 27) {
      this.require(offset + 1, 8)
      const big = this.view.getBigUint64(offset + 1, false)
      // Values above 2^53 cannot be a length or a COSE label in any real credential; keeping them
      // as bigint rather than silently losing precision means a bogus one fails a comparison
      // instead of matching something it should not.
      const argument = big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big
      return { argument, offset: offset + 9 }
    }
    throw new Error(`Unsupported CBOR additional information ${additional} (indefinite lengths are rejected)`)
  }

  private asLength(argument: number | bigint): number {
    if (typeof argument === 'bigint' || argument > this.bytes.length) {
      throw new Error('CBOR item claims a length larger than the input')
    }
    return argument
  }

  decodeItem(offset: number): DecodeResult {
    this.require(offset, 1)
    const initial = this.bytes[offset] as number
    const majorType = initial >> 5

    switch (majorType) {
      case 0: {
        const read = this.readArgument(offset)
        return { value: read.argument, offset: read.offset }
      }
      case 1: {
        const read = this.readArgument(offset)
        const value = typeof read.argument === 'bigint' ? -1n - read.argument : -1 - (read.argument as number)
        return { value, offset: read.offset }
      }
      case 2: {
        const read = this.readArgument(offset)
        const length = this.asLength(read.argument)
        this.require(read.offset, length)
        return {
          value: this.bytes.subarray(read.offset, read.offset + length),
          offset: read.offset + length,
        }
      }
      case 3: {
        const read = this.readArgument(offset)
        const length = this.asLength(read.argument)
        this.require(read.offset, length)
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          this.bytes.subarray(read.offset, read.offset + length),
        )
        return { value: text, offset: read.offset + length }
      }
      case 4: {
        const read = this.readArgument(offset)
        const count = this.asLength(read.argument)
        const items: CborValue[] = []
        let cursor = read.offset
        for (let index = 0; index < count; index++) {
          const item = this.decodeItem(cursor)
          items.push(item.value)
          cursor = item.offset
        }
        return { value: items, offset: cursor }
      }
      case 5: {
        const read = this.readArgument(offset)
        const count = this.asLength(read.argument)
        const map: CborMap = new Map()
        let cursor = read.offset
        for (let index = 0; index < count; index++) {
          const key = this.decodeItem(cursor)
          const value = this.decodeItem(key.offset)
          if (
            typeof key.value !== 'string' &&
            typeof key.value !== 'number' &&
            typeof key.value !== 'bigint'
          ) {
            throw new Error('CBOR map keys must be integers or text strings')
          }
          if (map.has(key.value)) {
            // Duplicate keys are how one parser is made to disagree with another about the same
            // bytes. Reject rather than pick a winner.
            throw new Error('CBOR map contains a duplicate key')
          }
          map.set(key.value, value.value)
          cursor = value.offset
        }
        return { value: map, offset: cursor }
      }
      case 6: {
        // Tag: decode and discard the tag itself, returning the tagged item.
        const read = this.readArgument(offset)
        return this.decodeItem(read.offset)
      }
      case 7: {
        const additional = initial & 0x1f
        if (additional === 20) return { value: false, offset: offset + 1 }
        if (additional === 21) return { value: true, offset: offset + 1 }
        if (additional === 22) return { value: null, offset: offset + 1 }
        if (additional === 23) return { value: undefined, offset: offset + 1 }
        if (additional === 26) {
          this.require(offset + 1, 4)
          return { value: this.view.getFloat32(offset + 1, false), offset: offset + 5 }
        }
        if (additional === 27) {
          this.require(offset + 1, 8)
          return { value: this.view.getFloat64(offset + 1, false), offset: offset + 9 }
        }
        throw new Error(`Unsupported CBOR simple value ${additional}`)
      }
      default:
        throw new Error(`Unsupported CBOR major type ${majorType}`)
    }
  }
}

/** Decode exactly one CBOR item, rejecting any trailing bytes. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new CborReader(bytes)
  const result = reader.decodeItem(0)
  if (result.offset !== bytes.length) {
    throw new Error('CBOR input has trailing bytes after the top-level item')
  }
  return result.value
}

/** Decode one CBOR item and report where it ended, for buffers that continue past it. */
export function decodeCborPrefix(bytes: Uint8Array): { value: CborValue; bytesRead: number } {
  const reader = new CborReader(bytes)
  const result = reader.decodeItem(0)
  return { value: result.value, bytesRead: result.offset }
}

export function isCborMap(value: CborValue): value is CborMap {
  return value instanceof Map
}
