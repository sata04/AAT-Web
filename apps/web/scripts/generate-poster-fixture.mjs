#!/usr/bin/env node
/**
 * Regenerates the engine's byte-exact test fixtures:
 *
 *   test/fixtures/poster-spec-aat-poster-v1-72dpi.json   — the deterministic spec, exactly as
 *                                                          it is handed to `render_spec_json`
 *   test/fixtures/poster-aat-poster-v1-72dpi-pyodide.png — what Pyodide renders for it
 *
 * WASM CPython is byte-deterministic across runs and machines (verified: identical sha256 over
 * repeated renders and repeated boots), so the test asserts byte equality rather than a pixel
 * tolerance. The price of that strictness is the same discipline as `pytest --update-reference`:
 * re-run this script DELIBERATELY — after a pyodide upgrade or an intentional render change —
 * and review the resulting PNG diff before committing it. It must never be regenerated just to
 * make a red test green.
 *
 * The spec is built inside Python, replicating `poster-renderer/tests/conftest.py::build_spec`
 * and `deterministic_series` exactly (RandomState(20260725), 1450 points, dpi 72 — the same
 * shape as the container-era reference image, so a pixel comparison against
 * `tests/reference/aat-poster-v1-gravity-level-72dpi.png` stays meaningful).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { vendorPosterAssets } from './vendor-poster-assets.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_DIR, '..', '..')
const POSTER_SRC = join(REPO_ROOT, 'poster-renderer', 'src', 'poster_renderer')
const FIXTURE_DIR = join(APP_DIR, 'test', 'fixtures')
const ENTRY_PY = join(APP_DIR, 'src', 'poster', 'engine', 'entry.py')

const PYTHON_MODULES = [
  '__init__.py',
  'errors.py',
  'limits.py',
  'preset.py',
  'render.py',
  'validation.py',
  'version.py',
]

// Verbatim copy of conftest.py's deterministic_series + build_spec, minus pytest plumbing and
// with dpi overridden to 72 (the reference image's dpi). Keep in sync with conftest.py.
const SPEC_BUILDER_PY = `
import base64
import json
import numpy as np

def encode_series(values):
    array = np.ascontiguousarray(values, dtype=np.dtype("<f8"))
    return {"data": base64.b64encode(array.tobytes()).decode("ascii"), "length": int(array.size)}

rng = np.random.RandomState(20260725)
count = 1450
time = np.arange(count) / 1000.0
inner = 0.002 * np.sin(2 * np.pi * 3 * time) + rng.normal(0, 5e-4, count)
drag  = 0.004 * np.sin(2 * np.pi * 2 * time) + rng.normal(0, 8e-4, count)

spec = {
    "analysisRevisionId": "rev_01JQ0000000000000000000000",
    "runCode": "260725a",
    "posterKind": "auto",
    "posterPresetVersion": "aat-poster-v1",
    "xMin": 0.0, "xMax": 1.45, "yMin": -0.02, "yMax": 0.02,
    "series": "both", "title": "", "showLegend": True,
    "figureWidth": 10.6, "figureHeight": 3.4, "dpi": 72,
    "data": {
        "inner": {"time": encode_series(time), "values": encode_series(inner)},
        "drag":  {"time": encode_series(time), "values": encode_series(drag)},
    },
}
raw = json.dumps(spec, separators=(",", ":"), sort_keys=True).encode("utf-8")

import engine_entry
result = engine_entry.render_spec_json(raw)
assert result["ok"], result

{"raw": raw.decode("utf-8"), "png": result["png"], "versions": engine_entry.engine_versions()}
`

async function main() {
  const { version, outDir } = await vendorPosterAssets()
  const { loadPyodide } = await import('pyodide')

  console.log(`[poster-fixture] booting pyodide ${version} from ${outDir}`)
  const pyodide = await loadPyodide({ indexURL: outDir, packageBaseUrl: outDir })
  await pyodide.loadPackage(['matplotlib', 'numpy', 'pillow'])

  for (const name of PYTHON_MODULES) {
    pyodide.FS.mkdirTree('/poster-src/poster_renderer')
    pyodide.FS.writeFile(`/poster-src/poster_renderer/${name}`, readFileSync(join(POSTER_SRC, name)))
  }
  pyodide.FS.writeFile('/poster-src/engine_entry.py', readFileSync(ENTRY_PY))
  pyodide.runPython("import sys\nsys.path.insert(0, '/poster-src')")

  const proxy = pyodide.runPython(SPEC_BUILDER_PY)
  const { raw, png, versions } = proxy.toJs({ dict_converter: Object.fromEntries })
  proxy.destroy()

  console.log(`[poster-fixture] rendered under ${JSON.stringify(versions)}`)

  mkdirSync(FIXTURE_DIR, { recursive: true })
  writeFileSync(join(FIXTURE_DIR, 'poster-spec-aat-poster-v1-72dpi.json'), `${raw}\n`)
  writeFileSync(join(FIXTURE_DIR, 'poster-aat-poster-v1-72dpi-pyodide.png'), png)
  console.log(
    `[poster-fixture] wrote spec JSON + PNG fixtures to ${FIXTURE_DIR} ` + `(${png.byteLength} bytes of PNG)`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[poster-fixture] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}
