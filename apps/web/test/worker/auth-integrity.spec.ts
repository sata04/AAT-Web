import { createExecutionContext, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { getAuth } from '../../worker/auth/auth.ts'
import { passkey, registrationInvites, verification } from '../../worker/db/schema.ts'
import worker from '../../worker/index.ts'
import { VirtualAuthenticator } from './helpers/authenticator.ts'
import {
  apiFetch,
  createUser,
  db,
  issueInvitationToken,
  ORIGIN,
  RP_ID,
  redeemInvitation,
  registrationOptions,
  verifyRegistration,
} from './helpers/client.ts'
import { interceptD1 } from './helpers/intercept-d1.ts'

async function beginInvitation() {
  const token = await issueInvitationToken()
  const response = await redeemInvitation(token)
  expect(response.status).toBe(200)
  return ((await response.json()) as { registrationContext: string }).registrationContext
}

describe('registration context storage', () => {
  it('stores ciphertext that cannot start another ceremony and still completes registration', async () => {
    const context = await beginInvitation()
    const ceremony = await registrationOptions({ context })
    const rows = await db().select().from(verification)
    expect(rows.some((row) => row.value.includes(context))).toBe(false)
    const stored = rows
      .map((row) => JSON.parse(row.value) as { expectedChallenge?: string; context?: string })
      .find((row) => row.expectedChallenge === ceremony.challenge)
    expect(stored?.context?.startsWith('aat-registration-v1:')).toBe(true)
    const reused = await apiFetch(
      `/api/auth/passkey/generate-register-options?context=${encodeURIComponent(stored?.context ?? '')}`,
    )
    expect(reused.status).toBe(400)
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect(
      (await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))).status,
    ).toBe(200)
  })

  it('rechecks claim expiry after decrypting the completed ceremony', async () => {
    const context = await beginInvitation()
    const ceremony = await registrationOptions({ context })
    await db()
      .update(registrationInvites)
      .set({ claimExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(registrationInvites.status, 'claimed'))
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect(
      (await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))).status,
    ).toBe(410)
  })

  it('binds the encrypted context to the ceremony user', async () => {
    const context = await beginInvitation()
    const ceremony = await registrationOptions({ context })
    const rows = await db().select().from(verification)
    const row = rows.find(
      (entry) =>
        (JSON.parse(entry.value) as { expectedChallenge?: string }).expectedChallenge === ceremony.challenge,
    )
    if (!row) throw new Error('missing ceremony')
    const stored = JSON.parse(row.value) as { userData: { id: string } }
    stored.userData.id = 'different-ceremony-user'
    await db()
      .update(verification)
      .set({ value: JSON.stringify(stored) })
      .where(eq(verification.id, row.id))
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect(
      (await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))).status,
    ).toBe(400)
  })
})

it('sanitizes verification INSERT errors, logger messages, and nested causes', async () => {
  const context = await beginInvitation()
  const marker = 'sensitive-test-database-parameter'
  const failure = new Error(`${marker}:${context}`, { cause: new Error(`nested:${context}`) })
  const bindings = {
    ...env,
    DB: interceptD1(env.DB, async (sql, phase) => {
      if (phase === 'before' && /^insert into "verification"/i.test(sql)) throw failure
    }),
  }
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const infoLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const auth = getAuth(bindings)
    const response = await auth.handler(
      new Request(`${ORIGIN}/api/auth/passkey/generate-register-options?context=${context}`, {
        headers: { origin: ORIGIN },
      }),
    )
    expect(response.status).toBe(500)
    expect((await response.text()).includes(context)).toBe(false)
    const authContext = await auth.$context
    authContext.logger.error(marker, failure)
    authContext.logger.warn(marker, { token: context })
    const calls = [...errorLog.mock.calls, ...warnLog.mock.calls, ...infoLog.mock.calls]
    expect(calls.length).toBeGreaterThanOrEqual(3)
    const captured = JSON.stringify(calls)
    expect(captured.includes(context)).toBe(false)
    expect(captured.includes(marker)).toBe(false)
    for (const args of calls) {
      expect(args).toHaveLength(1)
      const diagnostic = JSON.parse(String(args[0])) as Record<string, unknown>
      expect(Object.keys(diagnostic).sort()).toEqual(['category', 'diagnosticId'])
      expect(diagnostic.diagnosticId).toMatch(/^[0-9A-Z]{26}$/)
      expect(['auth_error', 'auth_warning', 'auth_api_error']).toContain(diagnostic.category)
    }
  } finally {
    errorLog.mockRestore()
    warnLog.mockRestore()
    infoLog.mockRestore()
  }
})

describe('atomic last-passkey deletion across every surface', () => {
  it.each([
    ['me', 'me'],
    ['admin', 'admin'],
    ['plugin', 'plugin'],
    ['me', 'admin'],
    ['me', 'plugin'],
    ['admin', 'plugin'],
  ])('preserves one key when %s and %s both finish their ownership reads', async (first, second) => {
    const user = await createUser()
    const admin = await createUser({ role: 'Admin' })
    const ceremony = await registrationOptions({ cookie: user.cookie })
    const authenticator = new VirtualAuthenticator(RP_ID, ORIGIN)
    expect(
      (await verifyRegistration(ceremony, await authenticator.register(ceremony.challenge))).status,
    ).toBe(200)
    const keys = await db().select().from(passkey).where(eq(passkey.userId, user.userId))
    expect(keys).toHaveLength(2)

    let reads = 0
    let release = () => {}
    const bothRead = new Promise<void>((resolve) => {
      release = resolve
    })
    const bindings = {
      ...env,
      DB: interceptD1(env.DB, async (sql, phase) => {
        if (phase !== 'after' || !/^select .* from "passkey" where/i.test(sql)) return
        reads++
        if (reads === 2) release()
        await bothRead
      }),
    }
    function remove(surface: string, id: string): Promise<Response> {
      const path =
        surface === 'plugin'
          ? '/api/auth/passkey/delete-passkey'
          : surface === 'admin'
            ? `/api/v1/admin/passkeys/${id}`
            : `/api/v1/me/passkeys/${id}`
      return worker.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: surface === 'plugin' ? 'POST' : 'DELETE',
          headers: {
            origin: ORIGIN,
            cookie: surface === 'admin' ? admin.cookie : user.cookie,
            'content-type': 'application/json',
          },
          ...(surface === 'plugin' ? { body: JSON.stringify({ id }) } : {}),
        }),
        bindings,
        createExecutionContext(),
      )
    }
    const responses = await Promise.all([remove(first, keys[0]?.id ?? ''), remove(second, keys[1]?.id ?? '')])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 403])
    expect(reads).toBe(2)
    expect(await db().select().from(passkey).where(eq(passkey.userId, user.userId))).toHaveLength(1)
  })
})
