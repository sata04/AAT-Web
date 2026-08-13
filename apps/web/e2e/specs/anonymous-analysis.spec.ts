/**
 * The governing principle, asserted in a browser.
 *
 * `docs/web-architecture.md`: *local analysis is the product; the cloud is an optional
 * authenticated research workspace.* A researcher with no account must be able to load a CSV,
 * analyse it, look at the graph, select a range, read the statistics and export Excel — and this
 * spec is the thing that stops that from quietly becoming untrue.
 *
 * The strongest assertion here is the negative one: across the whole workflow the page makes
 * exactly one request to the API, the session probe that decides whether to offer a sign-in link,
 * and none at all to `/api/v1/runs`, `/api/v1/revisions` or `/api/v1/posters`. A regression that
 * routed any part of the analysis through the Worker would still *look* fine — the graph would
 * still draw — and this is what would catch it.
 */

import { dragRange, openCsv, repoCsv, setRange, statusLane, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'

test.describe('anonymous research flow', () => {
  test('opens, analyses, selects a range and exports without an account', async ({ page }) => {
    const apiRequests: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname)
    })

    await page.goto('/')

    // The cloud half is deployed and answering, and nobody is signed in — so the bar offers a
    // sign-in link and nothing else. This is the state the whole spec runs in.
    await expect(page.getByRole('link', { name: 'サインイン' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'サインアウト' })).toHaveCount(0)

    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)

    // The graph. `plot-frame` is labelled with the desktop's own figure title.
    const graph = page.getByRole('region', { name: /^The Gravity Level/ })
    await expect(graph).toBeVisible()
    await expect(graph.locator('canvas').first()).toBeVisible()

    // The dataset is listed, and the cloud lane says what is true: nothing was stored.
    await expect(
      page.getByRole('region', { name: 'データセット' }).getByText('normal_two_sensor_utf8'),
    ).toBeVisible()
    await expect(statusLane(page, 'クラウド同期')).toHaveText('ローカルのみ')
    await expect(statusLane(page, 'ポスター図')).toHaveText('未生成')

    /* -------------------------------------------------------------- range selection */

    const selection = page.getByRole('region', { name: '選択範囲の統計情報' })

    // Typed, not dragged: "exactly 0.500 to 1.500 s" is the span a method section quotes, and
    // dragging cannot express it. Dragging is covered — and currently found broken — below.
    await setRange(page, 0.5, 1.5)
    await expect(selection.getByText('選択範囲: 0.5000 秒 ～ 1.5000 秒 (範囲: 1.0000 秒)')).toBeVisible()

    const countRow = selection.getByRole('row', { name: /有効データ点数/ })
    await expect(countRow).toBeVisible()
    // 1.0 s at 1 kHz. The exact figure is the analysis suite's business; that it is a real count
    // rather than the em dash placeholder is this spec's.
    await expect(countRow.locator('td').first()).not.toHaveText('—')
    await expect(
      selection
        .getByRole('row', { name: /標準偏差/ })
        .locator('td')
        .first(),
    ).not.toHaveText('—')

    /* --------------------------------------------------------------------- export */

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Excelで書き出す' }).click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('normal_two_sensor_utf8.xlsx')

    const savedPath = await saved.path()
    const { readFileSync } = await import('node:fs')
    const bytes = readFileSync(savedPath)
    expect(bytes.byteLength).toBeGreaterThan(1024)
    // XLSX is a zip. Two bytes is the whole check that matters: a workbook was written, not an
    // error page or an empty blob.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')

    await expect(page.getByText('を書き出しました。')).toBeVisible()

    /* ------------------------------------------------- and the cloud stayed out of it */

    expect(new Set(apiRequests)).toEqual(new Set(['/api/v1/me']))
  })

  /**
   * Regression: dragging on the graph produced no selection at all in the built application.
   *
   * Two independent causes, both confirmed in this browser against the real bundle, and either one
   * alone was enough to make the feature inert:
   *
   *  1. `SelectionOverlay` binds its pointer listeners in an effect that returns early while
   *     `layerRef.current` is null — which it is on the first render, because the component renders
   *     nothing until the chart geometry arrives. Nothing in the dependency list changed when the
   *     layer appeared, so the effect never ran again and no handler was ever attached.
   *  2. uPlot appends its own root after the overlay in DOM order, and neither carried a
   *     `z-index`, so `elementFromPoint` returned `.u-over` and the pointer never reached the
   *     overlay even once the handlers were bound.
   *
   * The numeric inputs above the chart were unaffected throughout, which is why this survived: the
   * feature looked present, and the workaround was one field away.
   */
  test('drags a range on the graph', async ({ page }) => {
    await page.goto('/')
    await openCsv(page, repoCsv('normal_two_sensor_utf8.csv'))
    await waitForAnalysis(page)

    await dragRange(page)

    await expect(
      page.getByRole('region', { name: '選択範囲の統計情報' }).getByText(/^選択範囲: /),
    ).toBeVisible({ timeout: 5_000 })
  })

  test('offers the analyzer, not a sign-in wall, on the cloud screens', async ({ page }) => {
    await page.goto('/runs')
    await expect(page.getByText('保存した実験を表示するにはサインインが必要です')).toBeVisible()
    await expect(page.getByRole('link', { name: '解析画面へ', exact: true })).toBeVisible()

    await page.getByRole('link', { name: '解析画面へ', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('CSVファイルをドロップ')).toBeVisible()
  })
})
