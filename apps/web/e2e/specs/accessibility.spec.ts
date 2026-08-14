/**
 * Accessibility, on the screens a researcher actually uses.
 *
 * The analyzer is scanned twice — empty and loaded — because they are different screens: the loaded
 * one has the graph, the side panel, four data tables and the status bar, and none of that exists
 * before a file is opened. The cloud screens are scanned with real content for the same reason: an
 * empty table cannot fail a header-association or colour-contrast rule.
 *
 * `KNOWN` below is the register of violations that exist today. It is intentionally empty: the
 * analyzer has a document heading, selected navigation and dataset text meet contrast, and every
 * horizontally scrollable table is keyboard-focusable. The suite fails if any of those regress.
 * See `e2e/harness/a11y.ts` for why the register still exists instead of using a silent allowlist.
 */

import { expectOnlyRecordedViolations, type Finding, scanAccessibility } from '../harness/a11y.ts'
import {
  openCsv,
  RUN_FIXTURE,
  registerWithInvitation,
  repoCsv,
  setRange,
  statusLane,
  waitForAnalysis,
} from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

/** Known violations, as `screen · rule ×count`. Every entry is a defect to remove, not ignore. */
const KNOWN: readonly string[] = []

test.describe('accessibility', () => {
  test('the screens a signed-out visitor sees', async ({ page }, testInfo) => {
    const found: Finding[] = []

    await page.goto('/')
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'analyzer-empty')))

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)
    await setRange(page, 0.5, 1.5)
    await expect(
      page.getByRole('region', { name: '選択範囲の統計情報' }).getByText(/^選択範囲: /),
    ).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'analyzer-loaded')))

    await page.goto('/sign-in')
    await expect(page.getByRole('button', { name: 'パスキーでサインイン' })).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'sign-in')))

    await page.goto('/runs')
    await expect(page.getByText('保存した実験を表示するにはサインインが必要です')).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'runs-signed-out')))

    await page.goto('/nowhere')
    found.push(...(await scanAccessibility(page, testInfo, 'not-found')))

    expectOnlyRecordedViolations(
      found,
      KNOWN.filter((entry) =>
        ['analyzer-empty', 'analyzer-loaded', 'sign-in', 'runs-signed-out', 'not-found'].some((screen) =>
          entry.startsWith(`${screen} · `),
        ),
      ),
    )
  })

  test('the screens a signed-in researcher sees', async ({ page, harness, authenticator }, testInfo) => {
    void authenticator
    const found: Finding[] = []

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E アクセシビリティ',
    })

    await page.goto(`/register?token=${encodeURIComponent(token)}`)
    await expect(page.getByRole('button', { name: 'パスキーを作成' })).toBeEnabled()
    found.push(...(await scanAccessibility(page, testInfo, 'register')))

    await page.getByRole('button', { name: 'パスキーを作成' }).click()
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })

    await openCsv(page, RUN_FIXTURE, '260817a_data.csv')
    await waitForAnalysis(page)
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })

    await page.goto('/runs')
    await expect(page.getByRole('article', { name: '260817a' })).toBeVisible({ timeout: 30_000 })
    found.push(...(await scanAccessibility(page, testInfo, 'runs-gallery')))

    await page.getByRole('link', { name: '260817a' }).click()
    await expect(page.getByRole('heading', { level: 1, name: '260817a' })).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'run-detail')))

    await page.goto('/security')
    await expect(page.getByRole('region', { name: 'パスキー' })).toBeVisible()
    found.push(...(await scanAccessibility(page, testInfo, 'security')))

    expectOnlyRecordedViolations(
      found,
      KNOWN.filter((entry) =>
        ['register', 'runs-gallery', 'run-detail', 'security'].some((screen) =>
          entry.startsWith(`${screen} · `),
        ),
      ),
    )
  })

  test('the admin console', async ({ page, harness, authenticator }, testInfo) => {
    void authenticator
    const found: Finding[] = []

    const { token } = await harness.createInvitation({
      role: 'Admin',
      displayName: 'E2E アクセシビリティ管理者',
    })
    await registerWithInvitation(page, token)

    for (const [path, region, screen] of [
      ['/admin', 'デプロイの概要', 'admin-overview'],
      ['/admin/users', '利用者の一覧', 'admin-users'],
      ['/admin/invitations', '招待の一覧', 'admin-invitations'],
      ['/admin/runs', '保存容量の合計', 'admin-runs'],
      ['/admin/audit', '監査ログ', 'admin-audit'],
    ] as const) {
      await page.goto(path)
      await expect(page.getByRole('region', { name: region })).toBeVisible({ timeout: 30_000 })
      found.push(...(await scanAccessibility(page, testInfo, screen)))
    }

    expectOnlyRecordedViolations(
      found,
      KNOWN.filter((entry) => entry.startsWith('admin-')),
    )
  })
})
