/**
 * A virtual WebAuthn authenticator.
 *
 * The tests exercise the real ceremony end to end — real ECDSA P-256 keys, real CBOR, real DER
 * signatures — rather than stubbing verification out. Verification itself is now
 * `@simplewebauthn/server`'s, reached through `@better-auth/passkey`, so these tests are no longer
 * proving that a hand-written parser is correct; they are proving that AAT has *configured* that
 * verifier correctly. A software authenticator that produces genuine attestations and assertions is
 * what makes "the wrong relying party is refused" an assertion about the deployed configuration
 * rather than about a mock.
 *
 * What this deliberately mirrors from a real authenticator:
 *  - the `RegistrationResponseJSON` / `AuthenticationResponseJSON` shapes the browser's
 *    `navigator.credentials` API produces once serialised, with base64url fields and `id === rawId`,
 *  - ES256 signatures, DER-encoded, as every platform authenticator emits them,
 *  - a COSE_Key credential public key inside attested credential data inside a CBOR attestation
 *    object with `fmt: "none"`,
 *  - a signature counter that advances on every assertion,
 *  - an all-zero AAGUID, which is what a privacy-preserving platform authenticator reports.
 */

/* ------------------------------------------------------------------------------------------- */
/* Minimal CBOR encoder                                                                          */
/* ------------------------------------------------------------------------------------------- */

function encodeHead(majorType: number, argument: number): Uint8Array {
  if (argument < 24) return new Uint8Array([(majorType << 5) | argument])
  if (argument < 0x100) return new Uint8Array([(majorType << 5) | 24, argument])
  if (argument < 0x10000) return new Uint8Array([(majorType << 5) | 25, argument >> 8, argument & 0xff])
  return new Uint8Array([
    (majorType << 5) | 26,
    (argument >>> 24) & 0xff,
    (argument >>> 16) & 0xff,
    (argument >>> 8) & 0xff,
    argument & 0xff,
  ])
}

export type CborInput =
  | number
  | string
  | Uint8Array
  | Map<string | number, CborInput>
  | { [key: string]: CborInput }

export function encodeCbor(value: CborInput): Uint8Array {
  if (typeof value === 'number') {
    return value >= 0 ? encodeHead(0, value) : encodeHead(1, -1 - value)
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    return concat(encodeHead(3, bytes.length), bytes)
  }
  if (value instanceof Uint8Array) {
    return concat(encodeHead(2, value.length), value)
  }
  const entries: [string | number, CborInput][] =
    value instanceof Map ? [...value.entries()] : Object.entries(value)
  const parts: Uint8Array[] = [encodeHead(5, entries.length)]
  for (const [key, entry] of entries) {
    parts.push(encodeCbor(typeof key === 'number' ? key : String(key)))
    parts.push(encodeCbor(entry))
  }
  return concat(...parts)
}

function concat(...parts: Uint8Array[]): Uint8Array {
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

/* ------------------------------------------------------------------------------------------- */
/* base64url                                                                                     */
/* ------------------------------------------------------------------------------------------- */

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64Url(bytes: Uint8Array): string {
  let result = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] as number
    const byte1 = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0
    const byte2 = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0
    result += BASE64_CHARS.charAt(byte0 >> 2)
    result += BASE64_CHARS.charAt(((byte0 & 0x03) << 4) | (byte1 >> 4))
    result += index + 1 < bytes.length ? BASE64_CHARS.charAt(((byte1 & 0x0f) << 2) | (byte2 >> 6)) : ''
    result += index + 2 < bytes.length ? BASE64_CHARS.charAt(byte2 & 0x3f) : ''
  }
  return result.replace(/\+/g, '-').replace(/\//g, '_')
}

export function fromBase64Url(value: string): Uint8Array {
  const normalised = value.replace(/-/g, '+').replace(/_/g, '/')
  const lookup = new Int16Array(256).fill(-1)
  for (let index = 0; index < BASE64_CHARS.length; index++) {
    lookup[BASE64_CHARS.charCodeAt(index)] = index
  }
  const bytes = new Uint8Array(Math.floor((normalised.length * 6) / 8))
  let buffer = 0
  let bits = 0
  let out = 0
  for (let index = 0; index < normalised.length; index++) {
    const code = lookup[normalised.charCodeAt(index)] as number
    if (code < 0) continue
    buffer = (buffer << 6) | code
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[out++] = (buffer >> bits) & 0xff
    }
  }
  return bytes.subarray(0, out)
}

/* ------------------------------------------------------------------------------------------- */
/* Signature encoding                                                                            */
/* ------------------------------------------------------------------------------------------- */

/** WebCrypto signs ECDSA as raw r‖s; authenticators emit DER. Convert, so the server sees DER. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const encodeInteger = (component: Uint8Array): Uint8Array => {
    let start = 0
    while (start < component.length - 1 && component[start] === 0) start++
    let trimmed = component.subarray(start)
    if (((trimmed[0] as number) & 0x80) !== 0) {
      trimmed = concat(new Uint8Array([0]), trimmed)
    }
    return concat(new Uint8Array([0x02, trimmed.length]), trimmed)
  }
  const body = concat(encodeInteger(raw.subarray(0, 32)), encodeInteger(raw.subarray(32, 64)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

/* ------------------------------------------------------------------------------------------- */
/* The authenticator                                                                             */
/* ------------------------------------------------------------------------------------------- */

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

/**
 * `RegistrationResponseJSON`, as `@simplewebauthn/server` expects to receive it. The server checks
 * `id === rawId` (its way of asserting the client base64url-encoded the credential id) and
 * `type === 'public-key'` before it looks at anything cryptographic.
 */
export interface RegistrationResponseJson {
  id: string
  rawId: string
  type: 'public-key'
  authenticatorAttachment: 'platform'
  clientExtensionResults: Record<string, never>
  response: {
    clientDataJSON: string
    attestationObject: string
    transports: string[]
  }
}

/** `AuthenticationResponseJSON`, likewise. */
export interface AuthenticationResponseJson {
  id: string
  rawId: string
  type: 'public-key'
  authenticatorAttachment: 'platform'
  clientExtensionResults: Record<string, never>
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
  }
}

export class VirtualAuthenticator {
  private keyPair: CryptoKeyPair | null = null
  private coseKey: Uint8Array | null = null
  readonly credentialIdBytes: Uint8Array
  private signCount = 0

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    this.credentialIdBytes = crypto.getRandomValues(new Uint8Array(32))
  }

  get credentialId(): string {
    return toBase64Url(this.credentialIdBytes)
  }

  private async ensureKey(): Promise<CryptoKeyPair> {
    if (this.keyPair) return this.keyPair
    this.keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', this.keyPair.publicKey)
    const x = fromBase64Url(jwk.x as string)
    const y = fromBase64Url(jwk.y as string)
    // COSE_Key for ES256: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y.
    this.coseKey = encodeCbor(
      new Map<string | number, CborInput>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    )
    return this.keyPair
  }

  private async rpIdHash(): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.rpId) as BufferSource),
    )
  }

  private clientData(
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
    origin: string,
  ): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  private counterBytes(): Uint8Array {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, this.signCount, false)
    return bytes
  }

  /**
   * Produce a registration (attestation) response for `challenge`.
   *
   * `userVerified: false` models an authenticator that proved only presence — a security key
   * tapped without a PIN. The credential is otherwise perfectly valid, which is the point: the
   * server has to notice the missing flag rather than fail for some other reason.
   */
  async register(
    challenge: string,
    options: { userVerified?: boolean } = {},
  ): Promise<RegistrationResponseJson> {
    await this.ensureKey()
    this.signCount += 1

    const flags = FLAG_UP | FLAG_AT | (options.userVerified === false ? 0 : FLAG_UV)
    const credentialIdLength = new Uint8Array(2)
    new DataView(credentialIdLength.buffer).setUint16(0, this.credentialIdBytes.length, false)

    const authData = concat(
      await this.rpIdHash(),
      new Uint8Array([flags]),
      this.counterBytes(),
      new Uint8Array(16), // AAGUID: all zeros, as a platform authenticator reports
      credentialIdLength,
      this.credentialIdBytes,
      this.coseKey as Uint8Array,
    )

    const attestationObject = encodeCbor(
      new Map<string | number, CborInput>([
        ['fmt', 'none'],
        ['attStmt', new Map<string | number, CborInput>()],
        ['authData', authData],
      ]),
    )

    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(this.clientData('webauthn.create', challenge, this.origin)),
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
    }
  }

  /** Produce an assertion for `challenge`. `signCountOverride` forges a stalled counter. */
  async authenticate(
    challenge: string,
    options: { signCountOverride?: number; origin?: string; userVerified?: boolean } = {},
  ): Promise<AuthenticationResponseJson> {
    const keyPair = await this.ensureKey()
    if (options.signCountOverride === undefined) this.signCount += 1
    else this.signCount = options.signCountOverride

    const flags = FLAG_UP | (options.userVerified === false ? 0 : FLAG_UV)
    const authData = concat(await this.rpIdHash(), new Uint8Array([flags]), this.counterBytes())

    const clientDataJson = this.clientData('webauthn.get', challenge, options.origin ?? this.origin)
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', clientDataJson as BufferSource),
    )
    const signed = concat(authData, clientDataHash)
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        signed as BufferSource,
      ),
    )

    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64Url(clientDataJson),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawSignatureToDer(raw)),
      },
    }
  }
}
