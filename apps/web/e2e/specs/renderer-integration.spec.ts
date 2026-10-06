/**
 * Browser-built plot spec → the in-browser Python renderer → Worker validation → PNG bytes stored.
 *
 * This is the integration the rest of the poster machinery is built on, and it is the one place it
 * is asserted end to end with nothing faked in the middle:
 *
 *  - the spec is the one `@aat/plot-spec` built in the browser from the analysis's full-resolution
 *    arrays. It is captured off the wire rather than reconstructed here, so the bytes tested are
 *    the bytes the application sends.
 *  - the renderer is the real Python render core (`poster-renderer/src/poster_renderer`) running
 *    under Pyodide in a Web Worker inside the page under test — the same code the container used
 *    to run, pinned by the vendored Pyodide build the app ships. Nothing about the picture is
 *    produced in Node or stubbed.
 *  - the Worker validates the spec with the same Zod schema it deploys with, and refuses one that
 *    breaks the contract — asserted below with a real refusal, because "the Worker validates" is
 *    only meaningful if something is actually rejected. The PNG is uploaded with it, so the stored
 *    figure is exactly what the browser drew.
 *  - the PNG is read back through `GET /api/v1/posters/:id/image`, and its header is parsed. A
 *    stub returning a 1×1 pixel would pass a "did we get bytes" check and fails this one: the image
 *    has to be the preset's 10.6 × 3.4 inches at 300 dpi, and its `Software` text chunk has to name
 *    the renderer build that drew it.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openCsv, RUN_FIXTURE, registerWithInvitation, statusLane, waitForAnalysis } from '../harness/app.ts'
import { expect, test } from '../harness/fixtures.ts'
import { REPO_ROOT } from '../harness/stack.ts'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * `RENDERER_VERSION`, read from the renderer's own source rather than restated here.
 *
 * The property under test is "the stored figure and the PNG both name the render code that drew
 * them", not "the renderer is currently at version X". Pinning the literal tests the second thing,
 * and `RENDERER_VERSION` is a constant *designed to move* — it is bumped on every dependency update
 * that can shift a byte (`poster-renderer/README.md`, "Why the versions are pinned"). A pinned
 * literal therefore turns a correct bump into a red E2E run, and the obvious way to make that run
 * green again is to edit the literal without checking whether the two values still agree — which
 * is exactly the check being deleted.
 */
const RENDERER_VERSION = (() => {
  const source = readFileSync(path.join(REPO_ROOT, 'poster-renderer/src/poster_renderer/version.py'), 'utf8')
  const match = /^RENDERER_VERSION = "(.+?)"$/m.exec(source)
  if (match === null) {
    throw new Error('could not read RENDERER_VERSION from poster_renderer/version.py')
  }
  return match[1]
})()

/** The preset: 10.6 × 3.4 in at 300 dpi. */
const EXPECTED_WIDTH = Math.round(10.6 * 300)
const EXPECTED_HEIGHT = Math.round(3.4 * 300)

/** Read the IHDR chunk. The first chunk of a PNG is always IHDR, at a fixed offset. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC)
  expect(bytes.subarray(12, 16).toString('latin1')).toBe('IHDR')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

test.describe('real poster renderer', () => {
  test('draws the browser’s plot spec in the page and stores the PNG it drew', async ({
    page,
    harness,
    authenticator,
  }) => {
    void authenticator

    let specBody: string | null = null
    let specPath: string | null = null
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname
      if (path.endsWith('/poster/auto') && request.method() === 'POST') {
        specBody = request.postData()
        specPath = path
      }
    })

    const { token } = await harness.createInvitation({
      role: 'Researcher',
      displayName: 'E2E レンダラー',
    })
    await registerWithInvitation(page, token)

    await openCsv(page, RUN_FIXTURE, '260815a_data.csv')
    await waitForAnalysis(page)
    await expect(statusLane(page, 'クラウド同期')).toHaveText('保存済み', { timeout: 60_000 })
    // The engine has to boot Pyodide and render before the upload happens; the lane reports the
    // finished figure, so this wait covers the whole in-page pipeline.
    await expect(statusLane(page, 'ポスター図')).toHaveText('生成済み', { timeout: 240_000 })

    /* ---------------------------------------- what the browser actually sent to be stored */

    expect(specBody).not.toBeNull()
    const sent = JSON.parse(specBody ?? '{}') as {
      spec: {
        runCode: string
        posterKind: string
        posterPresetVersion: string
        dpi: number
        figureWidth: number
        figureHeight: number
        data: { inner?: { time: { length: number } } }
      }
      pngBase64: string
      engineVersion?: string
    }
    expect(sent.spec.runCode).toBe('260815a')
    expect(sent.spec.posterKind).toBe('auto')
    expect(sent.spec.posterPresetVersion).toBe('aat-poster-v1')
    expect(sent.spec.dpi).toBe(300)
    expect(sent.spec.figureWidth).toBeCloseTo(10.6, 5)
    expect(sent.spec.figureHeight).toBeCloseTo(3.4, 5)
    // Full resolution, not the decimated series the screen draws.
    expect(sent.spec.data.inner?.time.length ?? 0).toBeGreaterThan(1000)

    /* ---------------------------------------------------- the bytes the browser produced */

    expect(sent.pngBase64).toBeTruthy()
    const uploaded = Buffer.from(sent.pngBase64, 'base64')
    expect(pngSize(uploaded)).toEqual({ width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT })
    // Matplotlib writes the metadata the renderer asked it to — this is the byte-level fingerprint
    // of the real render core, and no stub in this repository produces it.
    expect(uploaded.toString('latin1')).toContain(`AAT poster-renderer ${RENDERER_VERSION}`)
    expect(uploaded.toString('latin1')).toContain('(aat-poster-v1)')
    // Several hundred kilobytes of line plot, not a placeholder.
    expect(uploaded.byteLength).toBeGreaterThan(20_000)

    /* ------------------------------------------------------------------ the record, and back */

    const figure = await harness.one<{ id: string; renderer_version: string; preset_version: string }>(
      `SELECT pf.id AS id, pf.renderer_version AS renderer_version, pf.preset_version AS preset_version
         FROM poster_figures pf
         JOIN analysis_revisions ar ON ar.id = pf.analysis_revision_id
         JOIN runs r ON r.id = ar.run_id
        WHERE r.run_code = ? AND pf.kind = 'auto'`,
      ['260815a'],
    )
    expect(figure?.preset_version).toBe('aat-poster-v1')
    // The record names the engine that drew it, which the browser reported with the upload.
    expect(figure?.renderer_version).toBeTruthy()
    if (sent.engineVersion !== undefined) {
      expect(figure?.renderer_version).toBe(sent.engineVersion)
    }

    const image = await page.request.get(`/api/v1/posters/${figure?.id}/image`)
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toContain('image/png')

    const bytes = Buffer.from(await image.body())
    // What comes back out is what the browser sent in — byte for byte.
    expect(bytes.equals(uploaded)).toBe(true)

    /* ----------------------------------- the Worker refuses a bad spec on the upload itself */

    const before = await harness.one<{ n: number }>('SELECT count(*) AS n FROM poster_figures')

    const invalid = JSON.parse(specBody ?? '{}') as { spec: Record<string, unknown> }
    invalid.spec.dpi = 5000 // outside the schema's 72–600
    const refused = await page.request.post(specPath ?? '', {
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify(invalid),
    })
    expect(refused.status()).toBe(400)
    // `worker/routes/posters.ts` re-parses the document with `@aat/plot-spec` and answers
    // INVALID_ANALYSIS_CONFIG with `reason: invalid_plot_spec` — the spec is the analysis
    // configuration of a figure, and the taxonomy has one code for that.
    expect(await refused.json()).toMatchObject({
      error: { code: 'INVALID_ANALYSIS_CONFIG', details: { reason: 'invalid_plot_spec' } },
    })

    // Nothing was stored: validation happens before any object write.
    const after = await harness.one<{ n: number }>('SELECT count(*) AS n FROM poster_figures')
    expect(after?.n).toBe(before?.n)
  })
})
