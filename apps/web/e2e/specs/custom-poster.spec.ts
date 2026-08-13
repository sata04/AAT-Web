/**
 * A custom formal poster, and the thing it must not do: replace the automatic one.
 *
 * The two figures have deliberately different lifecycles. The automatic poster is idempotent — one
 * per `(revision, preset version)`, claimed by a partial unique index — because it is the record of
 * the analysis. A custom figure is the opposite: adjusting the range or the axis bounds and
 * rendering again is a request for a *different picture*, so history accumulates and nothing is
 * overwritten. A conference poster and the paper it came from are two figures, and being able to
 * say which one was published is the whole reason both are kept.
 *
 * The PNG here comes from the real renderer container. Nothing about a custom poster is worth
 * testing against a fake image: the point of the frozen preset is what Matplotlib actually draws.
 */

import {
  openCsv,
  RUN_FIXTURE,
  registerWithInvitation,
  setRange,
  statusLane,
  waitForAnalysis,
} from '../harness/app.ts'
import { expect, rendererAvailable, test } from '../harness/fixtures.ts'

test.describe('custom poster', () => {
  test('renders a chosen range and keeps it alongside the automatic figure', async ({
    page,
    harness,
    authenticator,
  }) => {
    test.skip(
      !rendererAvailable,
      'The poster renderer container is not running; see the suite report for how to start it.',
    )
    void authenticator

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E ポスター作成者',
    })
    await registerWithInvitation(page, token)

    await openCsv(page, RUN_FIXTURE, '260814a_data.csv')
    await waitForAnalysis(page)
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })
    await expect(statusLane(page, 'ポスター図')).toHaveText('生成済み', { timeout: 120_000 })

    const revision = await harness.one<{ id: string }>(
      'SELECT ar.id AS id FROM analysis_revisions ar JOIN runs r ON r.id = ar.run_id WHERE r.run_code = ?',
      ['260814a'],
    )
    const auto = await harness.one<{ id: string; object_id: string | null }>(
      "SELECT id, object_id FROM poster_figures WHERE analysis_revision_id = ? AND kind = 'auto'",
      [revision?.id],
    )
    expect(auto?.object_id).not.toBeNull()

    /* ---------------------------------------------- choose a range and ask for a figure */

    await setRange(page, 0.4, 1.2)
    await expect(
      page.getByRole('region', { name: '選択範囲の統計情報' }).getByText(/^選択範囲: 0\.4000/),
    ).toBeVisible()

    await page.getByRole('button', { name: '正式ポスター図を作成' }).click()

    const dialog = page.getByRole('dialog', { name: '正式ポスター図を作成' })
    await expect(dialog).toBeVisible()
    // The selection prefills the bounds — the researcher does not retype what they just measured.
    await expect(dialog.getByLabel('開始 (s)')).toHaveValue('0.4')
    await expect(dialog.getByLabel('終了 (s)')).toHaveValue('1.2')

    await dialog.getByLabel('図の名前').fill('微小重力区間')
    await dialog.getByRole('button', { name: '作成' }).click()

    // The dialog shows the figure it just made, streamed from R2 through the Worker.
    await expect(dialog.getByRole('img', { name: /のポスター図$/ })).toBeVisible({ timeout: 120_000 })

    /* ------------------------------------------------ history, not replacement */

    const figures = await harness.sql<{ id: string; kind: string; status: string; object_id: string | null }>(
      'SELECT id, kind, status, object_id FROM poster_figures WHERE analysis_revision_id = ? ORDER BY kind',
      [revision?.id],
    )
    expect(figures.map((figure) => `${figure.kind}:${figure.status}`)).toEqual(['auto:ready', 'custom:ready'])

    const stillAuto = figures.find((figure) => figure.kind === 'auto')
    expect(stillAuto?.id).toBe(auto?.id)
    // The same stored object: the automatic figure was not re-rendered and not replaced.
    expect(stillAuto?.object_id).toBe(auto?.object_id)

    const custom = figures.find((figure) => figure.kind === 'custom')
    expect(custom?.object_id).not.toBe(auto?.object_id)

    // Two distinct PNGs in R2, both non-trivial.
    const objects = await harness.sql<{ byte_size: number; content_type: string }>(
      "SELECT byte_size, content_type FROM cloud_objects WHERE kind = 'poster' AND analysis_revision_id = ?",
      [revision?.id],
    )
    expect(objects).toHaveLength(2)
    for (const object of objects) {
      expect(object.content_type).toBe('image/png')
      expect(object.byte_size).toBeGreaterThan(2048)
    }

    /* ------------------------------------------------------- and it is listed as history */

    await dialog.getByRole('button', { name: '閉じる' }).click()
    const posterPanel = page.getByRole('region', { name: 'ポスター図' })
    await expect(posterPanel.getByRole('heading', { name: '作成した図' })).toBeVisible()
    await expect(posterPanel.getByRole('link', { name: /\d/ })).toHaveCount(1)
    // The automatic figure is still the one on display in the panel.
    await expect(posterPanel.getByRole('img', { name: '260814a の自動ポスター図' })).toBeVisible()

    // The run detail screen shows both, under their own headings.
    const run = await harness.one<{ id: string }>('SELECT id FROM runs WHERE run_code = ?', ['260814a'])
    await page.goto(`/runs/${run?.id}`)
    const posters = page.getByRole('region', { name: 'ポスター図' })
    await expect(posters.getByRole('img', { name: '260814a の自動ポスター図' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(posters.getByRole('img', { name: '260814a のカスタムポスター図' })).toBeVisible()
  })
})
