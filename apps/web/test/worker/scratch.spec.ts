/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { getAuth } from '../../worker/auth/auth.ts'
import { VirtualAuthenticator } from './helpers/authenticator.ts'
import { issueInvitationToken, apiFetch, ORIGIN, RP_ID } from './helpers/client.ts'

describe('scratch', () => {
  it('reports the real registration error', async () => {
    const token = await issueInvitationToken()
    const redeem = await apiFetch('/api/auth/aat/invitation/redeem', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    const redeemed = (await redeem.json()) as {
      registrationContext: string
      options: { challenge: string }
    }
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    const credential = await authenticator.register(redeemed.options.challenge)

    const auth = getAuth(env)
    let outcome = 'not-run'
    try {
      await auth.api.aatRegisterPasskey({
        body: { registrationContext: redeemed.registrationContext, credential },
        headers: new Headers({ origin: ORIGIN }),
      })
      outcome = 'succeeded'
    } catch (error) {
      outcome = `${(error as Error).message} :: ${(error as Error).stack?.split('\n').slice(0, 8).join(' | ')}`
    }
    expect(outcome).toBe('SHOW ME')
  })
})
