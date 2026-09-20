/**
 * The first-run guided tour, exercised against the real analyzer.
 *
 * The tour is a modal stage that drives the real pipeline behind a spotlight — real
 * `openFiles` calls, a real analysis, a real selection, a real compare — so this spec
 * exists to keep that contract real: the generated samples travel the same path a
 * researcher's own CSV would, skipping leaves the workspace pristine, and the
 * `aat.onboarding.v1` flag is the only reason it never shows twice.
 *
 * Everything is seeded "seen" by default — this spec is the exception.
 */

import type { Locator, Page } from '@playwright/test'
import { openCsv, repoCsv, setRange, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

/**
 * The tour's modal stage. Its accessible name comes from the hidden heading it cites
 * with `aria-labelledby`, so asking for the name is also asking that the labelling works.
 */
function tourStage(page: Page): Locator {
  return page.getByRole('dialog', { name: 'AAT Web のはじめてガイド' })
}

/** The live caption — `data-scene` names the scene currently showing. */
function tourCaption(stage: Locator): Locator {
  return stage.locator('[data-scene]')
}

/** The analyzer's dataset list — mounted only while at least one dataset is open. */
function datasets(page: Page): Locator {
  return page.getByRole('region', { name: 'データセット' })
}

/**
 * Record every `data-scene` value the caption takes, in order.
 *
 * The scenes advance on the tour's own clock (~25 s end to end), so asserting the
 * order by waiting on each id in turn can miss a short scene's whole window. Watching
 * the attribute instead records what actually played, and the comparison happens once,
 * at the end, when there is nothing left to race.
 */
async function recordScenes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tourScenes: string[]; __tourObserver: MutationObserver }
    const seen: string[] = []
    const record = () => {
      const value = document.querySelector('.onboarding-stage [data-scene]')?.getAttribute('data-scene')
      if (typeof value === 'string' && seen[seen.length - 1] !== value) seen.push(value)
    }
    record()
    const stage = document.querySelector('.onboarding-stage')
    if (stage !== null) {
      w.__tourObserver = new MutationObserver(record)
      w.__tourObserver.observe(stage, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-scene'],
      })
    }
    w.__tourScenes = seen
  })
}

function scenesSeen(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __tourScenes: string[] }).__tourScenes)
}

test.describe('onboarding tour', () => {
  test.use({ onboardingComplete: false })

  test('the demo drives the real analyzer and このまま試す keeps the samples', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    // The intro card is the welcome's copy verbatim: what this is, the three steps,
    // and that nothing leaves the browser.
    await expect(stage).toContainText('AAT Web')
    await expect(stage).toContainText('微小重力実験の加速度データを、ブラウザ上で解析します。')
    await expect(stage.getByRole('listitem')).toHaveText([
      'CSVファイルを読み込む',
      '列の対応を確認する',
      'グラフと統計で解析する',
    ])
    await expect(stage).toContainText(
      '解析はすべてこのブラウザ内で行われます。CSVファイルがクラウドへ送信されることはありません。',
    )

    const caption = tourCaption(stage)
    await expect(caption).toHaveAttribute('aria-live', 'polite')
    await expect(caption).toHaveAttribute('data-scene', 'intro')

    const demo = stage.getByRole('button', { name: 'デモを見る' })
    await expect(demo).toBeFocused()

    await recordScenes(page)
    await demo.click()

    // ingest: the generated 'sample-a.csv' lands in the real dataset list and the
    // real analysis lane runs to 完了 — no mock anywhere in the path.
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()
    await waitForAnalysis(page)

    // select/stats: the tour's selection is a real one — the range panel fills.
    await expect(page.getByRole('region', { name: '選択範囲の統計情報' })).toContainText('選択範囲:')

    // compare: the second sample arrives for real and 比較 mode is really on.
    await expect(datasets(page).getByRole('button', { name: 'sample-b', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '比較', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // The tour is ~25 s; the default expect timeout would cut it off mid-flight.
    await expect(caption).toHaveAttribute('data-scene', 'outro', { timeout: 60_000 })
    expect(await scenesSeen(page)).toEqual([
      'intro',
      'ingest',
      'graph',
      'select',
      'stats',
      'gestures',
      'gquality',
      'compare',
      'export',
      'outro',
    ])

    await stage.getByRole('button', { name: 'このまま試す' }).click()
    await expect(tourStage(page)).toHaveCount(0)

    // The analyzer keeps what the tour opened — a chart, not the drop zone.
    await expect(page.getByRole('region', { name: /Gravity/ })).toBeVisible()
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()
    await expect(datasets(page).getByRole('button', { name: 'sample-b', exact: true })).toBeVisible()

    // Seen means never again.
    await page.reload()
    await expect(tourStage(page)).toHaveCount(0)
  })

  test('サンプルデータで試す opens the generated CSV for real', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    await stage.getByRole('button', { name: 'サンプルデータで試す' }).click()
    await expect(tourStage(page)).toHaveCount(0)

    await waitForAnalysis(page)
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: /^The Gravity Level/ })).toBeVisible()
  })

  test('そのまま始める leaves the bare analyzer, and reload shows no stage', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    await stage.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(tourStage(page)).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()

    await page.reload()
    await expect(tourStage(page)).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('skipping mid-tour removes the datasets the tour opened', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await stage.getByRole('button', { name: 'デモを見る' }).click()
    const caption = tourCaption(stage)

    // Far enough in that ingest has really happened.
    await expect(caption).toHaveAttribute('data-scene', 'graph')
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(tourStage(page)).toHaveCount(0)

    // Pristine — the workspace is exactly as if the tour had never run.
    await expect(datasets(page)).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()

    await page.reload()
    await expect(tourStage(page)).toHaveCount(0)
  })

  test('skipping during ingest cannot leak the demo onto the workspace', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await stage.getByRole('button', { name: 'デモを見る' }).click()
    // Escape while sample-a's open/analysis is still in flight: the stage is
    // gone before the request lands, so the install must self-close rather
    // than appearing on a pristine workspace a moment later.
    await page.keyboard.press('Escape')
    await expect(stage).toHaveCount(0)

    // Well past the demo's analysis time — anything in flight has landed by now.
    await page.waitForTimeout(6_000)
    await expect(datasets(page)).toHaveCount(0)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
  })

  test("a researcher's own sample-a.csv survives a replayed tour", async ({ page }) => {
    await page.goto('/')
    await tourStage(page).getByRole('button', { name: 'そのまま始める' }).click()

    // Their own file happens to carry the demo's name — the tour must not
    // mistake it for tour data, at open or at cleanup.
    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'), 'sample-a.csv')
    await waitForAnalysis(page)

    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    const stage = tourStage(page)
    await stage.getByRole('button', { name: 'デモを見る' }).click()

    // The demo lands under its fallback name next to the researcher's file.
    const caption = tourCaption(stage)
    await expect(caption).toHaveAttribute('data-scene', 'graph')
    await expect(datasets(page).getByRole('button', { name: 'sample-a-tour', exact: true })).toBeVisible()
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(stage).toHaveCount(0)

    // The tour's dataset is gone; the researcher's is untouched.
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()
    await expect(datasets(page).getByRole('button', { name: /sample-a-tour|sample-b/ })).toHaveCount(0)
  })

  test("skipping a replayed tour hands the workspace's view back", async ({ page }) => {
    await page.goto('/')
    await tourStage(page).getByRole('button', { name: 'そのまま始める' }).click()

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)
    await setRange(page, 0.6, 1.4)
    const stats = page.locator('section[aria-label="選択範囲の統計情報"]')
    await expect(stats).toBeVisible()

    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '初回の案内をもう一度見る' }).click()
    const stage = tourStage(page)
    await stage.getByRole('button', { name: 'デモを見る' }).click()
    await expect(tourCaption(stage)).toHaveAttribute('data-scene', 'graph')

    await page.keyboard.press('Escape')
    await expect(stage).toHaveCount(0)

    // The selection the researcher left is still there — the tour gave the
    // workspace back rather than resetting it.
    await expect(
      datasets(page).getByRole('button', { name: 'normal_two_sensor_utf8', exact: true }),
    ).toBeVisible()
    await expect(stats).toBeVisible()
    await expect(datasets(page).getByRole('button', { name: /sample-/ })).toHaveCount(0)
  })

  test('is operable from the keyboard alone', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    await expect(stage.getByRole('button', { name: 'デモを見る' })).toBeFocused()

    // A dozen Tabs must never land outside the stage: the analyzer behind it is
    // inert to the keyboard while it is up, exactly like the dialogs before it.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab')
      expect(await stage.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }

    // Stepping by hand is keyboard-reachable: find 次へ, advance a scene, then 戻る back.
    const caption = tourCaption(stage)
    const next = stage.getByRole('button', { name: '次へ', exact: true })
    for (let i = 0; i < 25 && !(await next.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(next).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(caption).toHaveAttribute('data-scene', 'ingest')

    const back = stage.getByRole('button', { name: '戻る', exact: true })
    for (let i = 0; i < 25 && !(await back.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab')
    }
    await expect(back).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(caption).toHaveAttribute('data-scene', 'intro')

    await page.keyboard.press('Escape')
    await expect(tourStage(page)).toHaveCount(0)
    // Escape is a skip — whatever the stepped-into scene opened leaves with the stage.
    await expect(datasets(page)).toHaveCount(0)
  })

  test('re-opens from the operations guide at the intro', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await stage.getByRole('button', { name: 'そのまま始める' }).click()
    await expect(tourStage(page)).toHaveCount(0)

    await page.getByRole('button', { name: '操作ガイド', exact: true }).click()
    const help = page.getByRole('dialog', { name: '操作ガイド' })
    await expect(help).toBeVisible()
    await help.getByRole('button', { name: '初回の案内をもう一度見る' }).click()

    // The re-entry point now reopens the tour at its intro — the old welcome is gone.
    await expect(help).toHaveCount(0)
    const reopened = tourStage(page)
    await expect(reopened).toBeVisible()
    await expect(reopened).toContainText('微小重力実験の加速度データを、ブラウザ上で解析します。')
    await expect(tourCaption(reopened)).toHaveAttribute('data-scene', 'intro')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('keeps the caption, transport and skip reachable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 })
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    await expect(tourCaption(stage)).toBeVisible()
    for (const name of ['戻る', '次へ', '一時停止', '最初から', 'スキップ']) {
      await expect(stage.getByRole('button', { name, exact: true })).toBeVisible()
    }
    // Same convention as the analyzer specs: sane stacking means no horizontal overflow.
    expect(await page.evaluate(() => document.body.scrollWidth - document.body.clientWidth)).toBe(0)

    await stage.getByRole('button', { name: 'スキップ' }).click()
    await expect(tourStage(page)).toHaveCount(0)
  })
})

test.describe('onboarding tour — reduced motion', () => {
  test.use({ onboardingComplete: false, contextOptions: { reducedMotion: 'reduce' } })

  test('shows the stage but leaves the stepping to the user', async ({ page }) => {
    await page.goto('/')

    const stage = tourStage(page)
    await expect(stage).toBeVisible()
    const caption = tourCaption(stage)
    await expect(caption).toHaveAttribute('data-scene', 'intro')
    // The caption says autoplay is off and the scene is stepped through by hand.
    await expect(caption).toContainText(/次へ|手動|自動/)

    // This sleep is the assertion, and the only one in the suite allowed to be:
    // "did not auto-advance" can only be proven by letting real time pass. Four
    // seconds is well past any scene transition in a ~25 s autoplay.
    await page.waitForTimeout(4_000)
    await expect(caption).toHaveAttribute('data-scene', 'intro')

    // デモを見る obeys the same promise: it enters the first driving scene and
    // stops there. Without this check a "reduce" autoplay would flash through
    // every scene in about two seconds, which is exactly what happened once.
    await stage.getByRole('button', { name: 'デモを見る' }).click()
    await expect(caption).toHaveAttribute('data-scene', 'ingest')
    await expect(datasets(page).getByRole('button', { name: 'sample-a', exact: true })).toBeVisible()
    await waitForAnalysis(page)
    await page.waitForTimeout(4_000)
    await expect(caption).toHaveAttribute('data-scene', 'ingest')

    // Stepping by hand still drives the real analyzer.
    await stage.getByRole('button', { name: '次へ', exact: true }).click()
    await expect(caption).toHaveAttribute('data-scene', 'graph')

    await page.keyboard.press('Escape')
    await expect(tourStage(page)).toHaveCount(0)
  })
})
