/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:test'
import { describe, it } from 'vitest'
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
    try {
      await auth.api.aatRegisterPasskey({
        body: { registrationContext: redeemed.registrationContext, credential },
        headers: new Headers({ origin: ORIGIN }),
      })
      console.log('SCRATCH: registration succeeded')
    } catch (error) {
      console.log('SCRATCH ERROR:', (error as Error).message)
      console.log('SCRATCH STACK:', (error as Error).stack?.split('\n').slice(0, 12).join('\n'))
    }
  })
})
