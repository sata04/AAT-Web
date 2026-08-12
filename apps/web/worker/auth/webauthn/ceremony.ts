/**
 * WebAuthn ceremony verification: registration (attestation) and authentication (assertion).
 *
 * ## Why this is hand-written
 *
 * Better Auth 1.6.26 does not ship a passkey plugin — it was extracted into a separate package
 * that is not a dependency of this project and cannot be added here (see the report accompanying
 * this work). Rather than degrade to a password or an email link, which the product explicitly
 * does not have, the ceremony is implemented directly against WebCrypto. Everything else about the
 * session — cookie signing, expiry, revocation — still belongs to Better Auth; only the credential
 * verification lives here.
 *
 * ## What is verified, and what is deliberately not
 *
 * Verified on every ceremony, in the order §7.1/§7.2 of the WebAuthn spec gives them:
 *  - `clientData.type` matches the ceremony ("webauthn.create" / "webauthn.get"). Without this a
 *    signature harvested from one ceremony can be replayed into the other.
 *  - `clientData.challenge` equals the challenge this server issued, compared over raw bytes in
 *    constant time. The challenge is single-use: it is consumed from the database, so a replay
 *    finds nothing to consume.
 *  - `clientData.origin` is one of the configured trusted origins, by exact string equality. Not a
 *    suffix match — "evil-aat.example.ac.jp" ends with nothing of ours, but "aat.example.ac.jp.
 *    evil.test" would pass a naive `endsWith`.
 *  - The authenticator data's RP ID hash equals SHA-256 of the configured RP ID.
 *  - The user-present flag. User verification is required for registration and requested for
 *    authentication (see `requireUserVerification`).
 *  - On assertion: the signature over `authenticatorData ‖ SHA-256(clientDataJSON)`, and the
 *    signature counter, which must advance if the authenticator uses one at all.
 *
 * Not verified, on purpose: **attestation statements**. AAT is a small research group's tool with
 * invitation-only registration; the identity of the authenticator's manufacturer adds nothing that
 * the invitation has not already established, and demanding attestation would rule out the
 * platform authenticators (Touch ID, Windows Hello) these researchers actually use. The
 * attestation object is parsed only to read the credential out of it, and its `fmt` is ignored.
 */

import { sha256Hex } from '@aat/shared'
import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  timingSafeEqual,
} from '../../lib/encoding.ts'
import { decodeCbor, decodeCborPrefix, isCborMap } from './cbor.ts'
import { importCoseKey, importStoredCoseKey, verifySignature } from './cose.ts'

export class CeremonyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CeremonyError'
  }
}

const FLAG_USER_PRESENT = 0x01
const FLAG_USER_VERIFIED = 0x04
const FLAG_BACKUP_ELIGIBLE = 0x08
const FLAG_BACKED_UP = 0x10
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40

export interface AuthenticatorDataFields {
  rpIdHash: Uint8Array
  flags: number
  signCount: number
  credentialId: Uint8Array | null
  credentialPublicKey: Uint8Array | null
  aaguid: Uint8Array | null
}

/** Parse the fixed-layout authenticator data structure (WebAuthn §6.1). */
export function parseAuthenticatorData(authData: Uint8Array): AuthenticatorDataFields {
  if (authData.length < 37) {
    throw new CeremonyError('Authenticator data is shorter than the mandatory 37 bytes')
  }
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength)
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32] as number
  const signCount = view.getUint32(33, false)

  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) === 0) {
    return { rpIdHash, flags, signCount, credentialId: null, credentialPublicKey: null, aaguid: null }
  }

  if (authData.length < 55) {
    throw new CeremonyError('Authenticator data claims attested credential data but is too short')
  }
  const aaguid = authData.subarray(37, 53)
  const credentialIdLength = view.getUint16(53, false)
  const credentialIdEnd = 55 + credentialIdLength
  if (credentialIdEnd > authData.length) {
    throw new CeremonyError('Credential id length overruns the authenticator data')
  }
  const credentialId = authData.subarray(55, credentialIdEnd)
  // The COSE key is followed by an optional extensions map, so the key's own encoded length is the
  // only way to know where it ends. decodeCborPrefix reports exactly that.
  const remaining = authData.subarray(credentialIdEnd)
  const { bytesRead } = decodeCborPrefix(remaining)
  const credentialPublicKey = remaining.subarray(0, bytesRead)

  return { rpIdHash, flags, signCount, credentialId, credentialPublicKey, aaguid }
}

interface ClientData {
  type: string
  challenge: string
  origin: string
  crossOrigin?: boolean
}

function parseClientData(clientDataJson: Uint8Array): ClientData {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJson))
  } catch {
    throw new CeremonyError('clientDataJSON is not valid UTF-8 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CeremonyError('clientDataJSON is not an object')
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.challenge !== 'string' || typeof record.origin !== 'string') {
    throw new CeremonyError('clientDataJSON is missing required fields')
  }
  return {
    type: record.type,
    challenge: record.challenge,
    origin: record.origin,
    ...(typeof record.crossOrigin === 'boolean' ? { crossOrigin: record.crossOrigin } : {}),
  }
}

export interface CeremonyContext {
  rpId: string
  trustedOrigins: readonly string[]
  /** The challenge this server issued, base64url encoded exactly as it was sent to the client. */
  expectedChallenge: string
  requireUserVerification: boolean
}

async function verifyCommon(
  clientDataJson: Uint8Array,
  authData: Uint8Array,
  context: CeremonyContext,
  expectedType: 'webauthn.create' | 'webauthn.get',
): Promise<AuthenticatorDataFields> {
  const clientData = parseClientData(clientDataJson)

  if (clientData.type !== expectedType) {
    throw new CeremonyError(`clientData.type is "${clientData.type}", expected "${expectedType}"`)
  }

  // Compare decoded bytes, not the strings: a padded and an unpadded base64url encoding of the
  // same challenge are different strings but the same challenge, and constant-time comparison
  // keeps the check from leaking a prefix through timing.
  let receivedChallenge: Uint8Array
  let expectedChallenge: Uint8Array
  try {
    receivedChallenge = base64UrlToBytes(clientData.challenge)
    expectedChallenge = base64UrlToBytes(context.expectedChallenge)
  } catch {
    throw new CeremonyError('Challenge is not valid base64url')
  }
  if (!timingSafeEqual(receivedChallenge, expectedChallenge)) {
    throw new CeremonyError('Challenge does not match the one issued for this ceremony')
  }

  if (!context.trustedOrigins.includes(clientData.origin)) {
    throw new CeremonyError(`Origin "${clientData.origin}" is not a trusted origin`)
  }

  if (clientData.crossOrigin === true) {
    throw new CeremonyError('Cross-origin ceremonies are not accepted')
  }

  const fields = parseAuthenticatorData(authData)

  const expectedRpIdHash = await sha256Hex(context.rpId)
  const actualRpIdHash = bytesToHex(fields.rpIdHash)
  if (expectedRpIdHash !== actualRpIdHash) {
    throw new CeremonyError('Authenticator data was signed for a different relying party')
  }

  if ((fields.flags & FLAG_USER_PRESENT) === 0) {
    throw new CeremonyError('Authenticator did not report user presence')
  }
  if (context.requireUserVerification && (fields.flags & FLAG_USER_VERIFIED) === 0) {
    throw new CeremonyError('Authenticator did not report user verification')
  }

  return fields
}

export interface RegistrationCredential {
  /** base64url credential id as reported by the client. */
  id: string
  clientDataJson: string
  attestationObject: string
  transports?: readonly string[]
}

export interface VerifiedRegistration {
  credentialId: string
  /** COSE public key, base64url, stored verbatim. */
  publicKey: string
  algorithm: number
  signCount: number
  aaguid: string | null
  backedUp: boolean
  deviceType: 'singleDevice' | 'multiDevice'
}

/** Verify a registration ceremony and return everything that should be persisted. */
export async function verifyRegistration(
  credential: RegistrationCredential,
  context: CeremonyContext,
): Promise<VerifiedRegistration> {
  let clientDataJson: Uint8Array
  let attestationObject: Uint8Array
  try {
    clientDataJson = base64UrlToBytes(credential.clientDataJson)
    attestationObject = base64UrlToBytes(credential.attestationObject)
  } catch {
    throw new CeremonyError('Registration response is not valid base64url')
  }

  const decoded = decodeCbor(attestationObject)
  if (!isCborMap(decoded)) {
    throw new CeremonyError('Attestation object is not a CBOR map')
  }
  const authDataValue = decoded.get('authData')
  if (!(authDataValue instanceof Uint8Array)) {
    throw new CeremonyError('Attestation object has no authData')
  }

  const fields = await verifyCommon(clientDataJson, authDataValue, context, 'webauthn.create')

  if (!fields.credentialId || !fields.credentialPublicKey) {
    throw new CeremonyError('Registration produced no attested credential data')
  }
  if (fields.credentialId.length === 0 || fields.credentialId.length > 1023) {
    throw new CeremonyError('Credential id length is out of range')
  }

  const coseKey = decodeCbor(fields.credentialPublicKey)
  if (!isCborMap(coseKey)) {
    throw new CeremonyError('Credential public key is not a COSE key map')
  }
  // Importing here, at registration, is what guarantees the stored key is usable: a credential we
  // cannot verify against is a credential that locks the user out on their next sign-in.
  const imported = await importCoseKey(coseKey)

  const backedUp = (fields.flags & FLAG_BACKED_UP) !== 0
  const backupEligible = (fields.flags & FLAG_BACKUP_ELIGIBLE) !== 0

  return {
    credentialId: bytesToBase64Url(fields.credentialId),
    publicKey: bytesToBase64Url(fields.credentialPublicKey),
    algorithm: imported.algorithm,
    signCount: fields.signCount,
    aaguid: fields.aaguid ? bytesToBase64Url(fields.aaguid) : null,
    backedUp,
    deviceType: backupEligible ? 'multiDevice' : 'singleDevice',
  }
}

export interface AuthenticationCredential {
  id: string
  clientDataJson: string
  authenticatorData: string
  signature: string
  userHandle?: string | null
}

export interface StoredCredential {
  credentialId: string
  publicKey: string
  counter: number
}

export interface VerifiedAuthentication {
  newSignCount: number
  backedUp: boolean
}

/** Verify an assertion against a stored credential. */
export async function verifyAuthentication(
  credential: AuthenticationCredential,
  stored: StoredCredential,
  context: CeremonyContext,
): Promise<VerifiedAuthentication> {
  let clientDataJson: Uint8Array
  let authenticatorData: Uint8Array
  let signature: Uint8Array
  try {
    clientDataJson = base64UrlToBytes(credential.clientDataJson)
    authenticatorData = base64UrlToBytes(credential.authenticatorData)
    signature = base64UrlToBytes(credential.signature)
  } catch {
    throw new CeremonyError('Authentication response is not valid base64url')
  }

  const fields = await verifyCommon(clientDataJson, authenticatorData, context, 'webauthn.get')

  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJson as BufferSource))
  const signedData = concatBytes(authenticatorData, clientDataHash)

  const key = await importStoredCoseKey(stored.publicKey)
  const valid = await verifySignature(key, signature, signedData)
  if (!valid) {
    throw new CeremonyError('Assertion signature is invalid')
  }

  // Clone detection (WebAuthn §6.1.1). An authenticator that keeps a counter must advance it; one
  // that does not keep a counter reports 0 forever, and that is not a failure. A counter that goes
  // backwards or stalls at a non-zero value means two authenticators are answering for one
  // credential, which is the signature of a cloned key.
  if (fields.signCount !== 0 || stored.counter !== 0) {
    if (fields.signCount <= stored.counter) {
      throw new CeremonyError('Authenticator signature counter did not advance')
    }
  }

  return { newSignCount: fields.signCount, backedUp: (fields.flags & FLAG_BACKED_UP) !== 0 }
}

/** A fresh 32-byte challenge, base64url encoded for transport to the browser. */
export function newChallenge(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}
