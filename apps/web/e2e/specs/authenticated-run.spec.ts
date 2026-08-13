/**
 * The full cloud round trip: analyse, store, render, find it again.
 *
 * This is smoke test 7 of `docs/deployment.md` — "analyse a file, confirm the revision is saved,
 * confirm exactly one automatic poster is produced and reaches `ready`, and confirm the Run Gallery
 * shows it" — run against a real local stack rather than against a deployment.
 *
 * Some properties are asserted against the database rather than against the screen, because they
 * are properties of SQL statements and a status line agreeing with them is not the same thing as
 * them holding. "Exactly one automatic poster per revision" in particular is a partial unique index,
 * and the only way to ask whether it is doing its job is to submit the same request twice and count
 * the rows — which is what this spec does, with the exact bytes the browser sent the first time.
 */

import { openCsv, RUN_FIXTURE, registerWithInvitation, statusLane, waitForAnalysis } from '../harness/app.ts'
import { expect, rendererAvailable, test } from '../harness/fixtures.ts'

const RUN_CODE = '260811a'
const MEMO = '落下塔3号機。真空引き後、1回目。'

test.describe('authenticated research flow', () => {
  test('stores a revision, renders the automatic poster, and shows it in the gallery', async ({
    page,
    harness,
    authenticator,
  }) => {
    expect(authenticator.authenticatorId).not.toBe('')

    // The exact body of the automatic-poster request, kept so that the idempotency of that endpoint
    // can be tested with the browser's own document rather than with one invented here.
    let autoPosterBody: string | null = null
    let autoPosterPath: string | null = null
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/poster/auto') && request.method() === 'POST') {
        autoPosterBody = request.postData()
        autoPosterPath = path
      }
    })

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E 実験者',
    })
    await registerWithInvitation(page, token)
    const me = (await (await page.request.get('/api/v1/me')).json()) as { user: { id: string } }

    /* ------------------------------------------------------------------- analyse */

    await openCsv(page, RUN_FIXTURE)
    await waitForAnalysis(page)

    // The local analysis is finished and usable at this point; everything below is the optional
    // half, and the status bar reports the three lanes independently.
    await expect(page.getByRole('region', { name: /^The Gravity Level/ })).toBeVisible()
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })

    /* -------------------------------------------------------- what reached the cloud */

    const run = await harness.one<{ id: string; run_code: string; experiment_date: string }>(
      'SELECT id, run_code, experiment_date FROM runs WHERE owner_user_id = ?',
      [me.user.id],
    )
    expect(run?.run_code).toBe(RUN_CODE)

    const revisions = await harness.sql<{ id: string }>(
      'SELECT id FROM analysis_revisions WHERE run_id = ?',
      [run?.id],
    )
    expect(revisions).toHaveLength(1)
    const revisionId = revisions[0]?.id

    const snapshot = await harness.one<{ n: number }>(
      "SELECT count(*) AS n FROM cloud_objects WHERE kind = 'snapshot' AND analysis_revision_id = ?",
      [revisionId],
    )
    expect(snapshot?.n).toBe(1)

    /* ------------------------------------------------------------ the auto poster */

    test.skip(
      !rendererAvailable,
      'The poster renderer container is not running; see the suite report for how to start it.',
    )

    await expect(statusLane(page, 'ポスター図')).toHaveText('生成済み', { timeout: 120_000 })

    const poster = await harness.one<{ id: string; status: string; renderer_version: string | null }>(
      "SELECT id, status, renderer_version FROM poster_figures WHERE analysis_revision_id = ? AND kind = 'auto'",
      [revisionId],
    )
    expect(poster?.status).toBe('ready')
    // Produced by the pinned Python + Matplotlib image, not by a fixture.
    expect(poster?.renderer_version).toMatch(/^aat-poster-renderer\//)

    // The panel shows the figure that already exists; looking at it starts nothing.
    const posterPanel = page.getByRole('region', { name: 'ポスター図' })
    await expect(posterPanel.getByRole('img', { name: `${RUN_CODE} の自動ポスター図` })).toBeVisible()

    /* ------------------------------------- one automatic poster, however often it is asked for */

    expect(autoPosterBody).not.toBeNull()
    const repeat = await page.request.post(autoPosterPath ?? '', {
      headers: { 'content-type': 'application/json' },
      data: autoPosterBody ?? '',
    })
    expect(repeat.ok()).toBe(true)
    const repeated = (await repeat.json()) as { poster: { posterId: string; status: string } }
    expect(repeated.poster.posterId).toBe(poster?.id)
    expect(repeated.poster.status).toBe('ready')

    const afterRepeat = await harness.sql<{ id: string; attempt_count: number }>(
      "SELECT id, attempt_count FROM poster_figures WHERE analysis_revision_id = ? AND kind = 'auto'",
      [revisionId],
    )
    expect(afterRepeat).toHaveLength(1)
    // The row was read back rather than drawn again: the container was never asked a second time.
    expect(afterRepeat[0]?.attempt_count).toBe(1)

    /* ---------------------------------------------------------------- the gallery */

    await page.goto('/runs')
    const card = page.getByRole('article', { name: RUN_CODE })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card.getByText('260811a_data.csv')).toBeVisible()

    // The thumbnail is a stored PNG streamed through the Worker, and the status chips agree with it.
    await expect(card.getByRole('img', { name: `${RUN_CODE} の自動ポスター図` })).toBeVisible({
      timeout: 30_000,
    })
    const chips = card.getByRole('list', { name: '保存状態' })
    await expect(chips).toContainText('生成済み')
    await expect(chips).toContainText('r1')

    /* ------------------------------------------------------ the run detail, and a memo */

    await card.getByRole('link', { name: RUN_CODE }).click()
    await expect(page).toHaveURL(new RegExp(`/runs/${run?.id}$`))
    await expect(page.getByRole('heading', { level: 1, name: RUN_CODE })).toBeVisible()

    const memo = page.getByRole('region', { name: 'メモ' })
    await memo.getByRole('textbox').fill(MEMO)
    await memo.getByRole('button', { name: 'メモを保存' }).click()
    await expect
      .poll(
        async () =>
          (await harness.one<{ memo: string | null }>('SELECT memo FROM runs WHERE id = ?', [run?.id]))?.memo,
        { timeout: 30_000 },
      )
      .toBe(MEMO)

    // Reopened from the gallery, which is the only way to know the memo was stored rather than kept
    // in a component's state.
    await page.getByRole('link', { name: '← 実験一覧' }).click()
    await expect(page).toHaveURL(/\/runs$/)
    await page.getByRole('article', { name: RUN_CODE }).getByRole('link', { name: RUN_CODE }).click()

    await expect(page.getByRole('region', { name: 'メモ' }).getByRole('textbox')).toHaveValue(MEMO)
  })

  /**
   * Regression: re-analysing a stored run used to report a failure for something that succeeded.
   *
   * Opening the same CSV again — a new tab, a reload, tomorrow morning — used to end with the cloud
   * lane reading 失敗 and offering a retry that could never succeed, even though the data was fine.
   * `POST /runs` correctly reported `run_code_already_exists` and the revision was correctly reused;
   * what failed was the snapshot upload, with
   * `SNAPSHOT_INVALID / revision_already_has_a_different_snapshot` (422).
   *
   * The Worker accepts a byte-identical re-upload idempotently, but the browser could never produce
   * those bytes twice: the snapshot records when the analysis ran, and a second analysis genuinely
   * ran at a different time. So the only reachable branch was the refusal. `sync.ts` now skips the
   * upload when the resolved revision already carries a snapshot, which is correct because a
   * revision is immutable and identified by (source bytes, config) — there is nothing to update.
   *
   * This test is the reason the defect was found at all, so it stays as the guard against it
   * returning.
   */
  test('re-analysing an already-stored run syncs again instead of reporting a failure', async ({
    page,
    harness,
    authenticator,
  }) => {
    void authenticator

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E 再解析',
    })
    await registerWithInvitation(page, token)

    await openCsv(page, RUN_FIXTURE, '260812a_data.csv')
    await waitForAnalysis(page)
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })

    await page.reload()
    // Wait for the session probe: `runAnalysis` reads "am I signed in" as it starts, so a file
    // opened before the probe answers is analysed as a signed-out user would analyse it.
    await expect(page.getByRole('button', { name: 'サインアウト' })).toBeVisible()

    await openCsv(page, RUN_FIXTURE, '260812a_data.csv')
    await waitForAnalysis(page)
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 30_000 })
  })
})
