/**
 * Onboarding coverage that only a real browser can prove: the welcome shows
 * once against real storage, the contextual hints appear in the order the
 * features arrive, and the help re-entry point brings the welcome back.
 * Everything is seeded "seen" by default — this spec is the exception.
 */

import { openCsv, repoCsv, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

test.describe('onboarding', () => {
  test.use({ onboardingComplete: false })

  test('first run shows the welcome once, then hints as features arrive', async ({ page }) => {
    await page.goto('/')

    // The welcome answers what this is and that nothing leaves the browser.
    const welcome = page.getByRole('dialog')
    await expect(welcome).toBeVisible()
    await expect(welcome).toContainText('微小重力実験の加速度データ')
    await expect(welcome).toContainText('クラウドへ送信されることはありません')
    await expect(welcome.getByRole('button', { name: 'CSVを開く' })).toBeFocused()

    await welcome.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The drop zone stays the primary CTA; the quick-start flow sits inside it.
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
    await expect(page.getByText('列の対応を確認')).toBeVisible()
    await expect(page.getByText('グラフで解析')).toBeVisible()

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)

    // Hints arrive one at a time in the order features are met.
    const graphHint = page.getByRole('status').filter({ hasText: 'グラフ操作' })
    await expect(graphHint).toBeVisible()
    await graphHint.getByRole('button', { name: '分かりました' }).click()

    const rangeHint = page.getByRole('status').filter({ hasText: '範囲の統計' })
    await expect(rangeHint).toBeVisible()
    await rangeHint.getByRole('button', { name: '分かりました' }).click()

    // A second file is when comparison becomes relevant — and that is when it
    // is explained.
    await openCsv(page, repoCsv('comparison_a.csv'))
    await waitForAnalysis(page)
    const compareHint = page.getByRole('status').filter({ hasText: '比較' })
    await expect(compareHint).toBeVisible()
    await compareHint.getByRole('button', { name: '分かりました' }).click()
    await expect(compareHint).not.toBeVisible()

    // A returning session re-shows nothing — persistence is the whole point.
    await page.reload()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: 'グラフ操作' })).toHaveCount(0)

    // Help re-opens on demand, and can bring the welcome back explicitly.
    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    const help = page.getByRole('dialog')
    await expect(help.getByRole('heading', { name: '操作ガイド' })).toBeVisible()
    await expect(help.getByRole('heading', { name: 'グラフ操作' })).toBeVisible()
    await expect(help.getByRole('heading', { name: 'ローカルとクラウド' })).toBeVisible()
    await help.getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    await expect(page.getByRole('dialog')).toContainText('微小重力実験の加速度データ')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('re-showing the welcome works while a dataset is open', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'そのまま始める' }).click()

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)

    // The re-show is an explicit ask: the welcome must appear even though a
    // dataset is already open — auto-close only applies when a file arrives
    // while the welcome is up, not the other way around.
    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    const welcome = page.getByRole('dialog')
    await expect(welcome).toContainText('微小重力実験の加速度データ')
    await welcome.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('the inline explainers describe themselves while closed', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'そのまま始める' }).click()

    // Every `?` points at its bubble with `aria-describedby`, and every bubble
    // starts closed. Hiding a closed bubble with `display: none` would drop it
    // out of the accessibility tree, leaving the trigger describing nothing —
    // jsdom cannot see that because it applies no CSS, but Playwright's role
    // queries read the real tree, so an empty count is exactly that regression.
    const triggers = page.getByRole('button', { name: /の説明$/ })
    await expect(triggers.first()).toHaveAttribute('aria-expanded', 'false')
    expect(await page.getByRole('tooltip').count()).toBe(await triggers.count())
  })

  test('is operable from the keyboard alone', async ({ page }) => {
    await page.goto('/')

    // The welcome traps focus: the primary action is focused, Tab cycles
    // inside, and Escape closes — the graph's skip link is first after that.
    await expect(page.getByRole('button', { name: 'CSVを開く' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    const helpButton = page.getByRole('button', { name: '操作ガイド', exact: true })
    for (let i = 0; i < 25 && !(await helpButton.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(helpButton).toBeFocused()

    await page.keyboard.press('Enter')
    const help = page.getByRole('dialog')
    await expect(help.getByRole('heading', { name: '操作ガイド' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(helpButton).toBeFocused()
  })
})

test.describe('onboarding — reduced motion', () => {
  test.use({ onboardingComplete: false, contextOptions: { reducedMotion: 'reduce' } })

  test('the welcome and quick start render and dismiss normally', async ({ page }) => {
    await page.goto('/')
    const welcome = page.getByRole('dialog')
    await expect(welcome).toBeVisible()
    await welcome.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
  })
})
