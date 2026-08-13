/**
 * Authentication, through a real WebAuthn ceremony.
 *
 * Every session in this file is opened the way a researcher's is: an invitation is inserted into D1
 * the way `docs/deployment.md` tells an operator to insert the bootstrap one, the browser exchanges
 * it for a registration context, and Chromium's virtual authenticator produces a genuine
 * attestation that `@simplewebauthn/server` verifies. There is no back door and no mocked
 * `navigator.credentials` anywhere in this suite — see `e2e/harness/webauthn.ts` for why that
 * distinction is the whole point.
 *
 * What each test is really asserting:
 *
 *  - **the token never persists.** It is a bearer secret that creates an account, and
 *    `src/auth/invitation.ts` promises it is out of the URL before the first `await` and never
 *    reaches storage. Both halves are checked.
 *  - **the credential is discoverable and user-verified.** Sign-in sends no username, so it can only
 *    work if a resident credential was created; the server requires UV, so it can only work if the
 *    authenticator asserted it.
 *  - **the last passkey cannot be removed.** The disabled button is a hint; the Worker is the rule,
 *    and the rule is checked directly.
 *  - **recovery works from a device that has never seen this account.** A second browser context
 *    with its own authenticator, exactly as a replaced laptop would be.
 */

import { registerWithInvitation, signInWithPasskey, signOut } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'
import { addVirtualAuthenticator, credentialRelyingParties } from '../harness/webauthn.ts'

interface MeResponse {
  user: { id: string; displayName: string; role: string }
}

/** Ask the API who this browser is, from inside the page, so the session cookie is the one used. */
async function whoAmI(page: import('@playwright/test').Page): Promise<MeResponse> {
  const response = await page.request.get('/api/v1/me')
  expect(response.status()).toBe(200)
  return (await response.json()) as MeResponse
}

test.describe('passkey onboarding and sign-in', () => {
  test('registers the bootstrap administrator, scrubs the token, and signs back in', async ({
    page,
    harness,
    authenticator,
  }) => {
    // The bootstrap invitation of a fresh deployment: no creator, because there is no administrator
    // yet. This is docs/deployment.md's procedure, automated.
    const { id: invitationId, token } = await harness.createInvitation({
      role: 'Admin',
      displayName: 'E2E 管理者',
    })

    await page.goto(`/register?token=${encodeURIComponent(token)}`)

    /* ------------------------------------------------------- the token leaves no trace */

    await expect(page.getByRole('button', { name: 'パスキーを作成' })).toBeEnabled()

    // Out of the address bar, and out of history: `replaceLocation` rather than a push, so Back
    // does not put it back.
    expect(page.url()).not.toContain(token)
    expect(page.url()).not.toContain('token=')
    expect(await page.evaluate(() => window.location.search)).toBe('')

    // And out of every place a page can keep something.
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      cookie: document.cookie,
    }))
    expect(stored.local).not.toContain(token)
    expect(stored.session).not.toContain(token)
    expect(stored.cookie).not.toContain(token)

    // The screen shows who the invitation is for, which is the invitee's one chance to notice they
    // were sent someone else's link.
    await expect(page.getByRole('row', { name: /表示名/ })).toContainText('E2E 管理者')

    /* --------------------------------------------------------------- the ceremony */

    expect(await authenticator.credentialCount()).toBe(0)
    await page.getByRole('button', { name: 'パスキーを作成' }).click()

    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'サインアウト' })).toBeVisible()

    // A real credential now exists on the device, scoped to the relying party the Worker configured.
    expect(await authenticator.credentialCount()).toBe(1)
    expect(await credentialRelyingParties(authenticator)).toEqual(['localhost'])

    const me = await whoAmI(page)
    expect(me.user.displayName).toBe('E2E 管理者')
    expect(me.user.role).toBe('Admin')

    // The invitation is spent, atomically and permanently, and now names the user it produced.
    const invitation = await harness.one<{ status: string; used_by_user_id: string | null }>(
      'SELECT status, used_by_user_id FROM registration_invites WHERE id = ?',
      [invitationId],
    )
    expect(invitation?.status).toBe('used')
    expect(invitation?.used_by_user_id).toBe(me.user.id)

    /* ------------------------------------------------------- sign out, and back in */

    await signOut(page)
    const signedOut = await page.request.get('/api/v1/me')
    expect(signedOut.status()).toBe(401)

    // No username is typed anywhere here. That only works because the credential is discoverable.
    await signInWithPasskey(page)
    expect((await whoAmI(page)).user.id).toBe(me.user.id)
  })

  test('adds a second passkey, refuses to delete the last one, and recovers on a new device', async ({
    page,
    browser,
    harness,
    authenticator,
  }) => {
    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E 二台持ち',
    })
    await registerWithInvitation(page, token)
    const me = await whoAmI(page)

    await page.goto('/security')
    const passkeys = page.getByRole('region', { name: 'パスキー' })
    await expect(passkeys.getByRole('row')).toHaveCount(2) // header + one credential

    /* ------------------------------------------------- the last passkey is protected */

    await expect(passkeys.getByRole('button', { name: '削除' })).toBeDisabled()
    await expect(page.getByText('パスキーが1つしかないため削除できません')).toBeVisible()

    // The disabled button is a hint. This is the rule: `worker/routes/me.ts` counts the rows and
    // refuses, so a caller who bypasses the UI entirely still cannot do it.
    const only = await harness.one<{ id: string }>('SELECT id FROM passkey WHERE user_id = ?', [me.user.id])
    const refused = await page.request.delete(`/api/v1/me/passkeys/${only?.id}`)
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })

    /* ------------------------------------------------------------- a second device */

    // A second authenticator, because a single one would (correctly) refuse: the ceremony's
    // `excludeCredentials` already names the credential it holds. It is a USB security key rather
    // than a second platform authenticator because Chromium allows only one of those per browser —
    // which is also the truthful model of the situation, since a platform passkey is the machine.
    // Silencing the first is how the browser is told which device the user reached for.
    const second = await addVirtualAuthenticator(page, {
      transport: 'usb',
      session: authenticator.session,
    })
    await authenticator.setResponding(false)

    await page.getByRole('button', { name: 'パスキーを追加' }).click()
    await expect(page.getByText('パスキーを追加しました。')).toBeVisible({ timeout: 30_000 })
    await expect(passkeys.getByRole('row')).toHaveCount(3)
    expect(await second.credentialCount()).toBe(1)

    /* ------------------------------- and now deletion is allowed, down to the last one */

    await expect(passkeys.getByRole('button', { name: '削除' }).first()).toBeEnabled()
    await passkeys.getByRole('button', { name: '削除' }).first().click()
    await expect(page.getByText('パスキーを削除しました。')).toBeVisible({ timeout: 30_000 })
    await expect(passkeys.getByRole('row')).toHaveCount(2)
    await expect(passkeys.getByRole('button', { name: '削除' })).toBeDisabled()

    /* ------------------------------------------------------------------- recovery */

    // An administrator issues a recovery invitation naming the existing account. The device that
    // redeems it has never seen this deployment: a new context, a new authenticator, no cookies.
    const recovery = await harness.createInvitation({
      kind: 'recovery',
      role: 'Researcher',
      displayName: 'E2E 二台持ち',
      targetUserId: me.user.id,
    })

    const replacement = await browser.newContext()
    try {
      const newDevice = await replacement.newPage()
      await addVirtualAuthenticator(newDevice)
      await newDevice.goto(`/recover?token=${encodeURIComponent(recovery.token)}`)

      await expect(newDevice.getByRole('button', { name: 'パスキーを登録' })).toBeEnabled()
      expect(newDevice.url()).not.toContain(recovery.token)
      await newDevice.getByRole('button', { name: 'パスキーを登録' }).click()

      await expect(newDevice).toHaveURL(/\/$/, { timeout: 30_000 })
      // Recovery adds a credential to the existing account; it does not create a second one.
      const recovered = (await (await newDevice.request.get('/api/v1/me')).json()) as MeResponse
      expect(recovered.user.id).toBe(me.user.id)
    } finally {
      await replacement.close()
    }

    const total = await harness.one<{ n: number }>('SELECT count(*) AS n FROM passkey WHERE user_id = ?', [
      me.user.id,
    ])
    expect(total?.n).toBe(2)
  })
})
