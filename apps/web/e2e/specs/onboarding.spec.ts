/**
 * Onboarding coverage that only a real browser can prove: the tour's intro card
 * shows once against real storage, the contextual hints appear in the order the
 * features arrive, and the help re-entry point brings the tour back.
 * Everything is seeded "seen" by default — this spec is the exception.
 */

import { openCsv, repoCsv, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

test.describe('onboarding', () => {
  test.use({ onboardingComplete: false })

  test('first run shows the tour once, then hints as features arrive', async ({ page }) => {
    await page.goto('/')

    // The tour opens on its intro card, which carries the welcome's copy verbatim —
    // what this is, the three steps, and that nothing leaves the browser.
    const stage = page.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
    await expect(stage).toBeVisible()
    await expect(stage).toContainText('微小重力実験の加速度データ')
    await expect(stage.getByRole('listitem')).toHaveText([
      'CSVファイルを読み込む',
      '列の対応を確認する',
      'グラフと統計で解析する',
    ])
    await expect(stage).toContainText('クラウドへ送信されることはありません')
    await expect(stage.getByRole('button', { name: 'デモを見る' })).toBeFocused()

    await stage.getByRole('button', { name: 'そのまま始める' }).click()
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

    // Help re-opens on demand, and can bring the tour back explicitly — the old
    // standalone welcome is gone; the re-entry point lands on the tour's intro.
    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    const help = page.getByRole('dialog')
    await expect(help.getByRole('heading', { name: '操作ガイド' })).toBeVisible()
    await expect(help.getByRole('heading', { name: 'グラフ操作' })).toBeVisible()
    await expect(help.getByRole('heading', { name: 'ローカルとクラウド' })).toBeVisible()
    await help.getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    const reopened = page.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
    await expect(reopened).toContainText('微小重力実験の加速度データ')
    await expect(reopened.locator('[data-scene]')).toHaveAttribute('data-scene', 'intro')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('re-showing the tour works while a dataset is open', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'そのまま始める' }).click()

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)

    // The re-show is an explicit ask: the tour must appear even though a
    // dataset is already open — auto-close only applies when a file arrives
    // while the stage is up, not the other way around.
    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    const stage = page.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
    await expect(stage).toContainText('微小重力実験の加速度データ')
    await stage.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // The open dataset is untouched by the visit.
    await expect(
      page
        .getByRole('region', { name: 'データセット' })
        .getByRole('button', { name: 'normal_two_sensor_utf8', exact: true }),
    ).toBeVisible()
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

    // The stage traps focus: the primary action is focused, Tab cycles
    // inside, and Escape closes — the graph's skip link is first after that.
    await expect(page.getByRole('button', { name: 'デモを見る' })).toBeFocused()
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

  test('the tour intro renders and dismisses normally', async ({ page }) => {
    await page.goto('/')
    const stage = page.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
    await expect(stage).toBeVisible()
    await stage.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
  })
})
