/**
 * The admin console: issue an invitation, watch it become a user, and see both in the record.
 *
 * The console is a plain client over `/api/v1/admin/*`, and nothing it renders is a permission —
 * `worker/middleware/authorize.ts` re-checks the capability on every request. So this spec asserts
 * the two halves separately: that an administrator can do the work through the screens, and that a
 * researcher who reaches the same screens is told they cannot rather than being shown an empty
 * table that looks like "no data".
 *
 * The invitation issued here is redeemed for real, in a second browser context with its own
 * authenticator. An invitation that is created but never used proves only that a row was written.
 */

import { openCsv, RUN_FIXTURE, registerWithInvitation, statusLane, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'
import { addVirtualAuthenticator } from '../harness/webauthn.ts'

const ADMIN_NAME = 'E2E コンソール管理者'
const INVITEE_NAME = 'E2E 招待された研究者'

test.describe('admin console', () => {
  test('issues an invitation, lists the user it produced, reports storage and records it all', async ({
    page,
    browser,
    harness,
    authenticator,
  }) => {
    void authenticator

    const bootstrap = await harness.createInvitation({ role: 'Admin', displayName: ADMIN_NAME })
    await registerWithInvitation(page, bootstrap.token)

    // The administrative section only appears for an account that holds an administrative
    // capability, which is a courtesy rather than a boundary — but its absence would be a bug.
    await expect(page.getByRole('link', { name: '管理' })).toBeVisible()

    /* --------------------------------------------------------------- issue an invitation */

    await page.goto('/admin/invitations')
    const form = page.getByRole('region', { name: '招待の発行' })
    await expect(form).toBeVisible({ timeout: 30_000 })

    await form.getByLabel('表示名（登録後の識別子になります）').fill(INVITEE_NAME)
    await form.getByLabel('権限').selectOption('Researcher')
    await form.getByRole('button', { name: '招待を発行' }).click()

    // Shown exactly once, and never retrievable again: only the SHA-256 is stored.
    const secret = page.getByRole('region', { name: /登録用URL|招待/ }).first()
    const url = page.getByRole('textbox', { name: '登録用URL' })
    await expect(url).toBeVisible({ timeout: 30_000 })
    const registrationUrl = await url.inputValue()
    expect(registrationUrl).toContain('/register?token=')
    void secret

    await expect(page.getByRole('region', { name: '招待の一覧' })).toContainText(INVITEE_NAME)

    /* ------------------------------------------------- and it actually creates the account */

    const invitee = await browser.newContext()
    try {
      const inviteePage = await invitee.newPage()
      await addVirtualAuthenticator(inviteePage)
      await inviteePage.goto(registrationUrl)
      await expect(inviteePage.getByRole('button', { name: 'パスキーを作成' })).toBeEnabled()
      await inviteePage.getByRole('button', { name: 'パスキーを作成' }).click()
      await expect(inviteePage).toHaveURL(/\/$/, { timeout: 30_000 })

      // Give the new account something to occupy storage, so the storage report has a number that
      // means something rather than a row of zeroes.
      await openCsv(inviteePage, RUN_FIXTURE, '260816a_data.csv')
      await waitForAnalysis(inviteePage)
      await expect(statusLane(inviteePage, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })
    } finally {
      await invitee.close()
    }

    /* ------------------------------------------------------------------ the user list */

    await page.goto('/admin/users')
    const users = page.getByRole('region', { name: '利用者の一覧' })
    await expect(users).toBeVisible({ timeout: 30_000 })
    const inviteeRow = users.getByRole('row', { name: new RegExp(INVITEE_NAME) })
    await expect(inviteeRow).toBeVisible({ timeout: 30_000 })
    await expect(inviteeRow).toContainText('研究者')
    await expect(inviteeRow).toContainText('有効')

    /* ---------------------------------------------------------- quota and storage */

    await page.goto('/admin/runs')
    const totals = page.getByRole('region', { name: '保存容量の合計' })
    await expect(totals).toBeVisible({ timeout: 30_000 })
    // A real snapshot was stored a moment ago, so none of these can be zero.
    await expect(totals.getByRole('definition').first()).not.toHaveText('0 件')
    await expect(totals).toContainText('合計バイト数')

    const perUser = page.getByRole('region', { name: '利用者ごとの保存容量' })
    await expect(perUser).toContainText(INVITEE_NAME, { timeout: 30_000 })

    /* ------------------------------------------------------------------ the audit log */

    await page.goto('/admin/audit')
    const audit = page.getByRole('region', { name: '監査ログ' })
    await expect(audit).toBeVisible({ timeout: 30_000 })

    // The wire action names, which is what the filter, the route and `services/audit.ts` all use.
    await expect(audit).toContainText('invitation.create')
    await expect(audit).toContainText('invitation.claim')
    await expect(audit).toContainText('user.register')
    await expect(audit).toContainText('snapshot.upload')

    // The console's own view agrees with the rows the Worker wrote.
    const created = await harness.auditEntries('invitation.create')
    expect(created.length).toBeGreaterThan(0)
  })

  test('tells a researcher the console is not theirs, rather than showing an empty one', async ({
    page,
    harness,
    authenticator,
  }) => {
    void authenticator

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E 権限なし',
    })
    await registerWithInvitation(page, token)

    // No 管理 entry in the navigation for an account with no administrative capability.
    await expect(page.getByRole('link', { name: '管理' })).toHaveCount(0)

    // And reaching the URL directly says why, without a redirect that would make a bookmark do
    // something else silently.
    await page.goto('/admin/users')
    await expect(page.getByText('には管理権限がありません')).toBeVisible()
    await expect(page.getByRole('link', { name: '解析画面へ', exact: true })).toBeVisible()

    // The Worker is the enforcement, and it refuses independently of what the screen renders.
    const refused = await page.request.get('/api/v1/admin/users')
    expect(refused.status()).toBe(403)
    expect(await refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } })
  })
})
