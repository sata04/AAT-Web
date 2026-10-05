/**
 * The poster engine, exercised end to end in real Pyodide.
 *
 * This is not a mock: `bootPosterEngine` loads the same vendored WASM + wheels the browser
 * worker serves from `/pyodide/<version>/`, writes the same Python sources into the same
 * filesystem layout, and calls the same `render_spec_json` bridge. Pyodide runs under Node
 * without a DOM, which is what makes the engine testable here at all; `renderer.ts`'s Worker
 * shell is the only part not covered (it is a postMessage adapter — the rendering path is this
 * file's subject).
 *
 * WASM CPython is byte-deterministic — same inputs, same PNG bytes, every time, verified across
 * repeated boots — so the contract here is byte equality with the committed fixture, the same
 * discipline as `tests/test_reference_image.py`'s strict-bytes mode. The fixture is regenerated
 * ONLY by `node scripts/generate-poster-fixture.mjs`, and a regenerated PNG must be eyeballed
 * before it is committed: never regenerate just to make this test pass.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import {
  bootPosterEngine,
  PosterEngineError,
  type PosterEngineHost,
} from '../../src/poster/engine/engine-core.ts'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(join(appRoot, 'package.json'))
const pyodideVersion = (require('pyodide/package.json') as { version: string }).version
const assetDir = join(appRoot, 'node_modules', '.cache', 'poster-assets', 'pyodide', pyodideVersion)

const SPEC_FIXTURE = readFileSync(
  join(appRoot, 'test', 'fixtures', 'poster-spec-aat-poster-v1-72dpi.json'),
  'utf8',
)
const PNG_FIXTURE = new Uint8Array(
  readFileSync(join(appRoot, 'test', 'fixtures', 'poster-aat-poster-v1-72dpi-pyodide.png')),
)

let host: PosterEngineHost

beforeAll(async () => {
  // Vendor first so the suite stands alone on a fresh checkout. The script is a no-op when the
  // cache already exists.
  execFileSync(process.execPath, [join(appRoot, 'scripts/vendor-poster-assets.mjs')], {
    cwd: appRoot,
    stdio: 'inherit',
  })
  host = await bootPosterEngine({ indexURL: assetDir })
}, 120_000)

describe('poster engine (pyodide)', () => {
  it('renders the deterministic spec byte-identically to the committed fixture', async () => {
    const png = await host.renderSpecJson(SPEC_FIXTURE)
    expect(png.length).toBeGreaterThan(1_000)
    // PNG signature: the output must be a real PNG before byte equality is even meaningful.
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png).toEqual(PNG_FIXTURE)
  })

  it('reports the versions measured inside the interpreter', () => {
    const versions = host.versions()
    expect(versions.matplotlib).toMatch(/^\d+\.\d+\.\d+$/)
    expect(versions.numpy).toMatch(/^\d+\.\d+\.\d+$/)
    expect(versions.pillow).toMatch(/^\d+\.\d+\.\d+$/)
    expect(versions.renderer).toMatch(/^aat-poster-renderer\//)
  })

  it('rejects an invalid spec as a spec-kind error, not an engine fault', async () => {
    const spec = JSON.parse(SPEC_FIXTURE) as { runCode: string }
    spec.runCode = 'ABC'
    const broken = JSON.stringify(spec)
    const error = await host.renderSpecJson(broken).then(
      () => {
        throw new Error('expected a spec rejection')
      },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(PosterEngineError)
    const engineError = error as PosterEngineError
    expect(engineError.kind).toBe('spec')
    expect(engineError.code).toBe('POSTER_SPEC_INVALID')
    expect(engineError.field).toBe('runCode')
    // The never-echo rule: the rejected VALUE must not appear anywhere in the error.
    expect(engineError.message).not.toContain('ABC')
  })

  it('serialises concurrent renders instead of interleaving them', async () => {
    const [a, b] = await Promise.all([host.renderSpecJson(SPEC_FIXTURE), host.renderSpecJson(SPEC_FIXTURE)])
    expect(a).toEqual(PNG_FIXTURE)
    expect(b).toEqual(PNG_FIXTURE)
  })
})
