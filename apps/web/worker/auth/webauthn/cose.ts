/**
 * COSE credential public keys, and verifying the signatures made with them.
 *
 * An authenticator returns its public key as a COSE_Key (RFC 8152) map inside the attestation
 * object. This module turns that map into a WebCrypto `CryptoKey` and verifies assertion
 * signatures against it.
 *
 * Supported algorithms are ES256 (-7), RS256 (-257) and EdDSA/Ed25519 (-8) — the three that
 * WebAuthn authenticators actually produce. Anything else is rejected at registration time rather
 * than stored and discovered to be unverifiable later, when the user is locked out.
 */

import { base64UrlToBytes, bytesToBase64Url, concatBytes } from '../../lib/encoding.ts'
import { type CborMap, decodeCbor, isCborMap } from './cbor.ts'

export const COSE_ALG_ES256 = -7
export const COSE_ALG_EDDSA = -8
export const COSE_ALG_RS256 = -257

const SUPPORTED_ALGORITHMS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256] as const

/** The COSE algorithm identifiers this deployment offers during registration, best first. */
export const OFFERED_ALGORITHMS: readonly number[] = [COSE_ALG_ES256, COSE_ALG_RS256, COSE_ALG_EDDSA]

const COSE_KEY_TYPE = 1
const COSE_ALGORITHM = 3
const COSE_CURVE = -1
const COSE_RSA_MODULUS = -1
const COSE_EC_X = -2
const COSE_RSA_EXPONENT = -2
const COSE_EC_Y = -3

const KEY_TYPE_OKP = 1
const KEY_TYPE_EC2 = 2
const KEY_TYPE_RSA = 3

const CURVE_P256 = 1
const CURVE_ED25519 = 6

export class UnsupportedCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCredentialError'
  }
}

function readInteger(map: CborMap, label: number): number {
  const value = map.get(label)
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new UnsupportedCredentialError(`COSE key is missing integer label ${label}`)
}

function readBytes(map: CborMap, label: number): Uint8Array {
  const value = map.get(label)
  if (!(value instanceof Uint8Array)) {
    throw new UnsupportedCredentialError(`COSE key label ${label} is not a byte string`)
  }
  return value
}

export interface ParsedCoseKey {
  algorithm: number
  /** The COSE key bytes exactly as received, base64url encoded — this is what gets stored. */
  key: CryptoKey
}

/**
 * Import a COSE_Key map as a verification key.
 *
 * Note the P-256 coordinate length check: WebCrypto's JWK import would accept a short `x` by
 * left-padding it, which means two different COSE encodings could import to the same key. Refusing
 * anything but exactly 32 bytes keeps the stored bytes and the imported key in one-to-one
 * correspondence.
 */
export async function importCoseKey(coseKey: CborMap): Promise<ParsedCoseKey> {
  const keyType = readInteger(coseKey, COSE_KEY_TYPE)
  const algorithm = readInteger(coseKey, COSE_ALGORITHM)

  if (!SUPPORTED_ALGORITHMS.includes(algorithm as (typeof SUPPORTED_ALGORITHMS)[number])) {
    throw new UnsupportedCredentialError(`Unsupported COSE algorithm ${algorithm}`)
  }

  if (keyType === KEY_TYPE_EC2) {
    if (algorithm !== COSE_ALG_ES256) {
      throw new UnsupportedCredentialError(`EC2 keys must use ES256, got algorithm ${algorithm}`)
    }
    const curve = readInteger(coseKey, COSE_CURVE)
    if (curve !== CURVE_P256) {
      throw new UnsupportedCredentialError(`Unsupported EC2 curve ${curve}`)
    }
    const x = readBytes(coseKey, COSE_EC_X)
    const y = readBytes(coseKey, COSE_EC_Y)
    if (x.length !== 32 || y.length !== 32) {
      throw new UnsupportedCredentialError('P-256 coordinates must be exactly 32 bytes each')
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: bytesToBase64Url(x), y: bytesToBase64Url(y), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    return { algorithm, key }
  }

  if (keyType === KEY_TYPE_RSA) {
    if (algorithm !== COSE_ALG_RS256) {
      throw new UnsupportedCredentialError(`RSA keys must use RS256, got algorithm ${algorithm}`)
    }
    const modulus = readBytes(coseKey, COSE_RSA_MODULUS)
    const exponent = readBytes(coseKey, COSE_RSA_EXPONENT)
    if (modulus.length < 256) {
      throw new UnsupportedCredentialError('RSA modulus is shorter than 2048 bits')
    }
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: bytesToBase64Url(modulus), e: bytesToBase64Url(exponent), alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    return { algorithm, key }
  }

  if (keyType === KEY_TYPE_OKP) {
    if (algorithm !== COSE_ALG_EDDSA) {
      throw new UnsupportedCredentialError(`OKP keys must use EdDSA, got algorithm ${algorithm}`)
    }
    const curve = readInteger(coseKey, COSE_CURVE)
    if (curve !== CURVE_ED25519) {
      throw new UnsupportedCredentialError(`Unsupported OKP curve ${curve}`)
    }
    const x = readBytes(coseKey, COSE_EC_X)
    if (x.length !== 32) {
      throw new UnsupportedCredentialError('Ed25519 public keys must be exactly 32 bytes')
    }
    const key = await crypto.subtle.importKey('raw', x as BufferSource, { name: 'Ed25519' }, false, ['verify'])
    return { algorithm, key }
  }

  throw new UnsupportedCredentialError(`Unsupported COSE key type ${keyType}`)
}

/**
 * Re-import a stored credential public key.
 *
 * The COSE map is stored verbatim (base64url) rather than as SPKI or JWK, so the bytes on disk are
 * exactly the bytes the authenticator produced and nothing has been normalised away between
 * registration and the first assertion.
 */
export async function importStoredCoseKey(storedBase64Url: string): Promise<ParsedCoseKey> {
  const decoded = decodeCbor(base64UrlToBytes(storedBase64Url))
  if (!isCborMap(decoded)) {
    throw new UnsupportedCredentialError('Stored credential public key is not a COSE key map')
  }
  return importCoseKey(decoded)
}

/**
 * Convert a DER-encoded ECDSA signature (SEQUENCE of two INTEGERs) to the fixed-width r‖s form
 * WebCrypto expects.
 *
 * Authenticators emit DER for ES256; WebCrypto's ECDSA verify only accepts raw. DER INTEGERs are
 * signed and minimally encoded, so r and s arrive with a leading zero byte when their high bit is
 * set and without leading zeros otherwise — both cases have to be normalised to exactly 32 bytes.
 */
function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('ECDSA signature is not a DER SEQUENCE')
  }
  // The sequence length may itself be long-form for signatures over 127 bytes, which P-256 never
  // produces; rejecting keeps the parser small and the input space narrow.
  if ((der[1] as number) & 0x80) {
    throw new Error('ECDSA signature uses an unexpected long-form length')
  }
  if (der[1] !== der.length - 2) {
    throw new Error('ECDSA signature length does not match its contents')
  }

  let offset = 2
  const readInteger32 = (): Uint8Array => {
    if (der[offset] !== 0x02) throw new Error('ECDSA signature component is not a DER INTEGER')
    const length = der[offset + 1] as number
    const start = offset + 2
    const end = start + length
    if (end > der.length) throw new Error('ECDSA signature component overruns the signature')
    let component = der.subarray(start, end)
    // Strip DER's sign byte, then left-pad to the curve's fixed width.
    while (component.length > 32 && component[0] === 0x00) component = component.subarray(1)
    if (component.length > 32) throw new Error('ECDSA signature component is larger than the curve order')
    offset = end
    const padded = new Uint8Array(32)
    padded.set(component, 32 - component.length)
    return padded
  }

  const r = readInteger32()
  const s = readInteger32()
  if (offset !== der.length) throw new Error('ECDSA signature has trailing bytes')
  return concatBytes(r, s)
}

/** Verify `signature` over `data` with a credential public key. Returns false rather than throwing. */
export async function verifySignature(
  parsed: ParsedCoseKey,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (parsed.algorithm === COSE_ALG_ES256) {
      const raw = derToRawEcdsaSignature(signature)
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        parsed.key,
        raw as BufferSource,
        data as BufferSource,
      )
    }
    if (parsed.algorithm === COSE_ALG_RS256) {
      return await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        parsed.key,
        signature as BufferSource,
        data as BufferSource,
      )
    }
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      parsed.key,
      signature as BufferSource,
      data as BufferSource,
    )
  } catch {
    // A malformed signature is an invalid signature. Distinguishing the two for the caller would
    // only give an attacker a parser oracle.
    return false
  }
}
