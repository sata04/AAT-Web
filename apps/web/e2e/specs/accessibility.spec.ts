/**
 * Accessibility, on the screens a researcher actually uses.
 *
 * The analyzer is scanned twice — empty and loaded — because they are different screens: the loaded
 * one has the graph, the side panel, four data tables and the status bar, and none of that exists
 * before a file is opened. The cloud screens are scanned with real content for the same reason: an
 * empty table cannot fail a header-association or colour-contrast rule.
 *
 * `KNOWN` below is the register of violations that exist today. Each is a defect in `src/`, each is
 * named with its rule and the element it fires on, and the suite fails if a new one appears *or* if
 * a recorded one is fixed without being removed from the list. See `e2e/harness/a11y.ts` for why it
 * is written this way rather than as a hard zero or as a silent allowlist.
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

/**
 * Known violations, as `screen · rule ×count`. Every one of these is a defect in `src/`.
 *
 * 1. **`page-has-heading-one` on the analyzer** (moderate). Every other screen gets an `<h1>` from
 *    `ScreenFrame`; the analyzer keeps its own instrument-panel grid and has none. It is the
 *    landing screen and the one a screen-reader user arrives at first, so it is the worst place in
 *    the application for the document to have no title. `src/screens/AnalyzerScreen.tsx`.
 * 2. **`color-contrast` on the current navigation item** (serious). `aria-current="page"` is
 *    styled with a foreground that does not reach 4.5:1 against the command bar, so the one item
 *    that says *where you are* is the least readable one. It fires on every screen that has the
 *    navigation — the gallery, the run detail, the security screen and all five admin sections.
 *    `src/styles/app.css`, the `.app-nav__link[aria-current]` rule.
 * 3. **`color-contrast` on the dataset list** (serious). `.dataset-list__name` in the analyzer's
 *    side panel, same cause.
 * 4. **`scrollable-region-focusable`** (serious). `.table-scroll` scrolls horizontally when a table
 *    is wider than the panel, but carries no `tabindex`, so a keyboard user cannot reach the
 *    columns that are off-screen. It wraps every data table in the application; it fires where the
 *    content actually overflows at this viewport (1440×900) — the analyzer's statistics table and
 *    the gallery's per-card metrics.
 *
 * None of these is fixed here: they live in `src/`, which this suite does not modify.
 */
const KNOWN: readonly string[] = [
  'admin-audit · color-contrast ×1',
  'admin-invitations · color-contrast ×1',
  'admin-overview · color-contrast ×1',
  'admin-runs · color-contrast ×1',
  'admin-users · color-contrast ×1',
  'analyzer-empty · page-has-heading-one ×1',
  'analyzer-loaded · color-contrast ×1',
  'analyzer-loaded · page-has-heading-one ×1',
  'analyzer-loaded · scrollable-region-focusable ×1',
  'run-detail · color-contrast ×1',
  'runs-gallery · color-contrast ×1',
  'runs-gallery · scrollable-region-focusable ×1',
  'security · color-contrast ×1',
]

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
