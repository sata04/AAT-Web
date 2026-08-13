/**
 * Chromium's WebAuthn virtual authenticator, driven over CDP.
 *
 * This is the only honest way to test AAT's authentication end to end. A stubbed
 * `navigator.credentials` proves that the screen calls a function; it proves nothing about the
 * ceremony, and the ceremony is where every interesting property of this system lives — that the
 * relying-party id is the one the Worker configured, that a discoverable credential is created so
 * sign-in needs no username, that user verification is actually asserted, that the invitation is
 * spent by a *verified* attestation and not by a button press. So the authenticator below is the
 * browser's own: real ES256 keys, real CBOR, real CTAP2, real `@simplewebauthn/server` verification
 * on the other end.
 *
 * The options mirror what `worker/auth/passkey-plugin.ts` demands of a real device:
 *
 *   `residentKey: 'required'`      → `hasResidentKey: true`
 *   `userVerification: 'required'` → `hasUserVerification: true` and `isUserVerified: true`
 *
 * An authenticator without those would be refused by the server, which is a property worth having:
 * it means a passing test cannot have been passed by a device that only proved presence.
 *
 * `transport: 'internal'` plus a synced backup state models a platform passkey (Touch ID, Windows
 * Hello, iCloud Keychain), which is what a researcher will actually use.
 */

import type { CDPSession, Page } from '@playwright/test'

export interface VirtualAuthenticator {
  /** The CDP session the authenticator lives on. Dies with the page. */
  session: CDPSession
  authenticatorId: string
  /** How many credentials this device currently holds. */
  credentialCount: () => Promise<number>
  /** Temporarily stop this device from answering, so another one is used instead. */
  setResponding: (responding: boolean) => Promise<void>
  remove: () => Promise<void>
}

export interface AuthenticatorOptions {
  /**
   * `internal` is a platform authenticator (Touch ID, Windows Hello) and is the default. Chromium
   * allows exactly one of those per browser, so a *second* device in the same browser has to be
   * `usb` — a security key, which is the other thing a researcher plugs in and the case the
   * "add a passkey on another device" flow exists for.
   */
  transport?: 'internal' | 'usb'
  /** Add to an existing CDP session — i.e. a second device attached to the same page. */
  session?: CDPSession
}

/** Attach a virtual authenticator to `page`. */
export async function addVirtualAuthenticator(
  page: Page,
  options: AuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const session = options.session ?? (await page.context().newCDPSession(page))
  if (options.session === undefined) {
    // `enableUI: false` keeps Chromium's account-picker bubble out of the way; the ceremony still
    // runs in full, the browser simply does not ask a human which credential to use.
    await session.send('WebAuthn.enable', { enableUI: false })
  }

  const transport = options.transport ?? 'internal'
  const { authenticatorId } = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      // A synced platform passkey is backup-eligible and backed up; a security key is neither.
      defaultBackupEligibility: transport === 'internal',
      defaultBackupState: transport === 'internal',
    },
  })

  return {
    session,
    authenticatorId,
    credentialCount: async () => {
      const { credentials } = await session.send('WebAuthn.getCredentials', { authenticatorId })
      return credentials.length
    },
    setResponding: async (responding: boolean) => {
      await session.send('WebAuthn.setAutomaticPresenceSimulation', {
        authenticatorId,
        enabled: responding,
      })
    },
    remove: async () => {
      await session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    },
  }
}

/** The relying-party ids this authenticator holds discoverable credentials for. */
export async function credentialRelyingParties(authenticator: VirtualAuthenticator): Promise<string[]> {
  const { credentials } = await authenticator.session.send('WebAuthn.getCredentials', {
    authenticatorId: authenticator.authenticatorId,
  })
  return credentials.map((credential) => credential.rpId ?? '')
}
