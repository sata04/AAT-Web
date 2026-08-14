/**
 * Browser-built plot spec → Worker validation → the real Python renderer → PNG bytes.
 *
 * This is the integration the rest of the poster machinery is built on, and it is the one place it
 * is asserted end to end with nothing faked in the middle:
 *
 *  - the spec is the one `@aat/plot-spec` built in the browser from the analysis's full-resolution
 *    arrays. It is captured off the wire rather than reconstructed here, so the bytes tested are
 *    the bytes the application sends.
 *  - the Worker validates it with the same Zod schema it deploys with, and refuses a spec that
 *    breaks the contract *before* a container is ever started — asserted below with a real refusal,
 *    because "the Worker validates" is only meaningful if something is actually rejected.
 *  - the renderer is `poster-renderer/Dockerfile` built and run under Docker: pinned base image,
 *    hash-pinned wheels, Matplotlib Agg. The Durable Object that would drive a Cloudflare Container
 *    in production forwards to it over HTTP (see `e2e/worker/entry.ts`); everything on the AAT side
 *    of that boundary is the deployed code.
 *  - the PNG is read back through `GET /api/v1/posters/:id/image`, and its header is parsed. A
 *    stub returning a 1×1 pixel would pass a "did we get bytes" check and fails this one: the image
 *    has to be the preset's 10.6 × 3.4 inches at 300 dpi, and its `Software` text chunk has to name
 *    the renderer build that drew it.
 *
 * If the container is not available the test is skipped loudly rather than passing against nothing.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { openCsv, RUN_FIXTURE, registerWithInvitation, statusLane, waitForAnalysis } from '../harness/app.ts'
import { expect, rendererAvailable, test } from '../harness/fixtures.ts'
import { REPO_ROOT } from '../harness/stack.ts'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * `RENDERER_VERSION`, read from the renderer's own source rather than restated here.
 *
 * The property under test is "the stored record and the PNG both name the build that drew them",
 * not "the renderer is currently at version X". Pinning the literal tests the second thing, and
 * `RENDERER_VERSION` is a constant *designed to move* — it is bumped on every dependency update
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
  test.skip(
    !rendererAvailable,
    'The poster renderer container is not running. Build it with `docker build -t aat-poster-renderer:ci poster-renderer` and re-run; the suite starts and stops it itself.',
  )

  test('draws the browser’s plot spec and returns a real PNG', async ({ page, harness, authenticator }) => {
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
    await expect(statusLane(page, 'ポスター図')).toHaveText('生成済み', { timeout: 120_000 })

    /* ---------------------------------------- what the browser actually sent to be drawn */

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
    }
    expect(sent.spec.runCode).toBe('260815a')
    expect(sent.spec.posterKind).toBe('auto')
    expect(sent.spec.posterPresetVersion).toBe('aat-poster-v1')
    expect(sent.spec.dpi).toBe(300)
    expect(sent.spec.figureWidth).toBeCloseTo(10.6, 5)
    expect(sent.spec.figureHeight).toBeCloseTo(3.4, 5)
    // Full resolution, not the decimated series the screen draws.
    expect(sent.spec.data.inner?.time.length ?? 0).toBeGreaterThan(1000)

    /* ------------------------------------------------------------------ the bytes back */

    const figure = await harness.one<{ id: string; renderer_version: string; preset_version: string }>(
      `SELECT pf.id AS id, pf.renderer_version AS renderer_version, pf.preset_version AS preset_version
         FROM poster_figures pf
         JOIN analysis_revisions ar ON ar.id = pf.analysis_revision_id
         JOIN runs r ON r.id = ar.run_id
        WHERE r.run_code = ? AND pf.kind = 'auto'`,
      ['260815a'],
    )
    expect(figure?.preset_version).toBe('aat-poster-v1')
    // The record names the build that drew it: the container reported this through
    // `X-Poster-Renderer-Version`, and it has to be the version the image was actually built from.
    expect(figure?.renderer_version).toBe(RENDERER_VERSION)

    const image = await page.request.get(`/api/v1/posters/${figure?.id}/image`)
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toContain('image/png')

    const bytes = Buffer.from(await image.body())
    expect(pngSize(bytes)).toEqual({ width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT })
    // Matplotlib writes the metadata the renderer asked it to. This is the byte-level fingerprint
    // of the pinned image: no stub in this repository produces it.
    expect(bytes.toString('latin1')).toContain(`AAT poster-renderer ${RENDERER_VERSION}`)
    expect(bytes.toString('latin1')).toContain('(aat-poster-v1)')
    // Several hundred kilobytes of line plot, not a placeholder.
    expect(bytes.byteLength).toBeGreaterThan(20_000)

    /* ------------------------------- the Worker refuses a bad spec before the container runs */

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

    // Nothing was claimed, so nothing was drawn: validation happens before any container work.
    const after = await harness.one<{ n: number }>('SELECT count(*) AS n FROM poster_figures')
    expect(after?.n).toBe(before?.n)
  })
})
