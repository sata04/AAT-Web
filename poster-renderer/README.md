# poster-renderer

The canonical formal-poster renderer for AAT Web: a Python + Matplotlib package that turns
an already-analysed numeric series and a declarative plot specification into a PNG.

It runs inside the browser under Pyodide (CPython compiled to WASM), in a dedicated Web Worker —
see `apps/web/src/poster/engine/`. The HTTP service and container image it used to ship as have
been removed. It performs **no analysis** — every number it draws was computed by
`packages/analysis-core` in the browser, bit-for-bit compatibly with the desktop application
(see `docs/numerical-compatibility.md`). Its one job is to be the *only* place in AAT
Web where a formal research figure is drawn, so that figure looks the same today, next year, and
on every machine.

Running the contract suite still only needs a pinned virtualenv:

```
poster-renderer/.venv/bin/python -m pytest poster-renderer/tests
```

---

## 1. The frozen visual contract

The desktop application writes `results_AAT/graphs/<name>_gl.png` from
`gui/plot_controller.py::plot_gravity_level`. Those PNGs go into papers and posters. AAT Web must
produce the same figure, so every visual constant in that code path is reproduced here, verified
line by line rather than eyeballed:

| Property | Value | Source |
| --- | --- | --- |
| Figure facecolor | `#FFFFFF` | `_get_export_palette()` |
| Axes facecolor | `#FFFFFF` | `_apply_export_theme()` |
| Inner Capsule line | `#0969DA` | `Colors.LIGHT_GRAPH_INNER_MEAN` |
| Drag Shield line | `#CF222E` | `Colors.LIGHT_GRAPH_DRAG_MEAN` |
| Line width | `0.8` | export branch of `plot_gravity_level` |
| Title | `The Gravity Level <name>` | export branch |
| X / Y label | `Time (s)` / `Gravity Level (G)` | export branch |
| Legend labels | `<name> (Inner Capsule)` / `<name> (Drag Shield)` | export branch |
| Legend frame | face `#FFFFFF`, edge `#D0D7DE`, text `#1F2328` | `_apply_export_theme()` |
| Spines | `#D0D7DE` | `_apply_export_theme()` |
| Ticks | `#656D76` | `_apply_export_theme()` |
| Grid | `--`, alpha `0.3`, `#656D76` | `_apply_export_theme()` |
| Watermark | `AAT v<version>` at axes `(0.98, 0.02)`, right/bottom, size 8, `#656D76` | `_add_version_watermark()` |
| Layout | `tight_layout()` | export branch |
| Save | `facecolor="#FFFFFF"`, `bbox_inches=None`, `dpi` from the spec | `savefig(...)` |
| Default geometry | `10.6in x 3.4in`, 300 dpi, x-range `0 .. 1.45s` | `config/config.default.json` |

All of it lives in one module, [`src/poster_renderer/preset.py`](src/poster_renderer/preset.py),
mirrored in TypeScript at `packages/plot-spec/src/presets.ts`. The assertions that freeze it are
in [`tests/test_visual_contract.py`](tests/test_visual_contract.py), a port of the desktop suite's
`tests/gui/test_export_graph_invariance.py`.

### Two details that are easy to get wrong

**The figure is laid out at 100 dpi and rasterised at 300.** The desktop builds its export figure
with `plt.figure(figsize=(w, h))` and no `dpi`, so it carries Matplotlib's default `figure.dpi` of
100. `tight_layout()` measures text with a renderer at *that* dpi and bakes the resulting subplot
geometry in; only then does `savefig(dpi=300)` rasterise. Creating the figure at 300 instead would
shift every element. `preset.LAYOUT_DPI` exists for this and must not be "simplified".

**The export never depended on the GUI theme, and here it structurally cannot.** The desktop keeps
a separate fixed light palette for saved images and has a test that flips the Qt theme and demands
byte-identical PNGs. This service has no UI at all; the equivalent risk is Matplotlib's global
rcParams, so `test_output_is_independent_of_ambient_rcparams` renders under a full dark palette
and requires the bytes not to move.

### `title` is the run's display name

The spec carries `runCode` (`"260725a"`) and `title`. The desktop draws its CSV basename — which
for this project *is* the run code — into the title and both legend labels, one name in three
places. So:

* `title == ""` → the name is `runCode`, giving exactly the desktop's figure.
* `title != ""` → that string replaces the *name*, not the title format. The title still reads
  `The Gravity Level <name>`, because a formal poster's title format is part of what makes it
  formal.

This is the one place where the render core's reading of `packages/plot-spec` is an interpretation
rather than a transcription. It is isolated in `PosterPlotSpec.display_name` so that reconciling
it with the client is a one-line change.

---

## 2. Why the versions are pinned

Two stacks matter now, pinned in two places:

| Stack | Pinned where | Why it moves pixels |
| --- | --- | --- |
| **Pyodide wheels** — matplotlib, numpy, pillow, inside the Pyodide build | the `pyodide` npm package in `pnpm-lock.yaml`; each wheel's sha256 in its `pyodide-lock.json`, verified by `apps/web/scripts/vendor-poster-assets.mjs` | What the browser actually draws with |
| **Native reference** — matplotlib, numpy, pillow | `requirements.txt`, `--require-hashes` | The desktop-parity oracle this suite compares against |

The native pins track what the desktop application's `uv.lock` resolves for Python >= 3.12 —
that equality is the whole point of keeping them. The Pyodide wheels are whatever the pinned
Pyodide release bundles, which is *not* the same set; `docs/poster-renderer.md` covers what
that divergence means for the reference tolerances and for `RENDERER_VERSION`.

FreeType and the font are *not* separate dependencies in either stack. They are compiled
and bundled into each Matplotlib wheel — manylinux on the native side, Pyodide's own wheel on
the browser side — which is why `--only-binary=:all:` matters: a locally built Matplotlib would
link a different FreeType and render different glyphs.

> **`requirements.txt` requires Python >= 3.12.** numpy 2.5.x publishes no cp311 wheels.

### Changing the contract

**Python, Matplotlib, NumPy, Pillow, FreeType, the font stack and the Pyodide build are
visual-contract changes. They must never be auto-merged.**

`renovate.json5` labels `poster-renderer/**` updates — and the `pyodide` npm package —
`visual-contract` / `needs-visual-review` and excludes them from auto-merge at every update
type, including patch (see `docs/supply-chain.md`). A patch bump that moves a tick label by one
pixel silently invalidates the guarantee this whole component exists to provide.

The review procedure:

1. Take the update on a branch.
2. Run the suite: `poster-renderer/.venv/bin/python -m pytest poster-renderer/tests`.
3. Run the engine suite: `pnpm --filter @aat/web test test/ui/poster-engine.test.ts`. For an
   intended Pyodide bump, regenerate the browser baseline with
   `node apps/web/scripts/generate-poster-fixture.mjs`.
4. If `test_reference_image.py` fails, **look at the two images**. Render the new one with
   `--update-reference`, open both, and decide whether the difference is acceptable.
5. If it is, and only then, commit the regenerated reference/fixture *with* the dependency bump
   in the same commit, so the pixel change and its cause are inseparable in the history.
6. If the *contract itself* is meant to change — a new colour, a new layout — that is not an
   edit to `aat-poster-v1`. It is a new preset version, so posters already stored keep rendering
   the way they always have. The exception is a preset that was **wrong about the desktop**: that
   is a defect in `v1`, not an alternative style, and it is fixed in place.
   `docs/versioning.md` sets out the distinction and the one case where it has been applied.

Note that bumping `RENDERER_VERSION` alone also fails `test_reference_is_byte_identical`, because
the version is written into the PNG's `Software` text chunk. That is a metadata change, not a
pixel change: confirm the images are identical, then regenerate the reference in the same commit.

Regenerating a reference image to make a test pass, without looking at it, defeats every other
safeguard in this directory.

---

## 3. The render core

The package is a pure spec-in / bytes-out module with no I/O of its own. The browser's Web Worker
(`apps/web/src/poster/engine/`) loads these sources into Pyodide and calls one entry point,
`render_spec_json`, exposed by `entry.py` on the engine side: a spec JSON document in, PNG bytes
out.

Input: the poster plot spec defined by `packages/plot-spec/src/spec.ts`. Numeric series arrive as
base64 of little-endian float64 (`wire.ts`), because JSON has no NaN — and `NaN` in a `values`
array is the documented "gap" marker, drawn as a break in the line.

Validation is a from-scratch reimplementation of the Zod schema, in
[`src/poster_renderer/validation.py`](src/poster_renderer/validation.py), with every limit in
[`src/poster_renderer/limits.py`](src/poster_renderer/limits.py). The client has already validated
the spec; the render core validates it again because a render core must never treat its caller as
trusted — the same document also arrives in the upload body from any client of the Worker's API.
Enforced: 8 MiB payload cap, 200,000 points per array, equal `time`/`values` lengths, finite
ordered axis bounds, finite `time` samples, no `±Infinity` anywhere, title <= 120 characters with
no control characters, the series / `posterKind` / preset enums, `dpi` in 72..600, figure
dimensions in 2..20 inches, and **no unknown keys anywhere**.

Two mirrors of one contract can drift, so `test_validation.py` asserts each constant by value
against `spec.ts`. It also closes two gaps where Python is laxer than JavaScript: `json.loads`
accepts the literals `NaN`/`Infinity` (rejected here), and Python's `\d` matches Unicode digits
(the run-code pattern is compiled with `re.ASCII`).

### Errors

`errors.py` raises `RendererError` subclasses that the bridge serialises as
`{"code", "message", "field?"}` — never quoting client input, so nothing client-controlled is
reflected back. `POSTER_SPEC_INVALID` means the spec failed validation; everything else surfaces
as `POSTER_RENDER_FAILED`. The client maps those onto the localised taxonomy in
`packages/shared/src/errors.ts`, plus `POSTER_ENGINE_UNAVAILABLE` for a worker that never booted.

### What the renderer cannot do

* No client-supplied code, ever. The spec is data; there is no field that becomes a callable.
* No client-supplied rcParams. Matplotlib's configuration is set once at import from
  `preset.FROZEN_RC_PARAMS` and never again.
* No client-supplied paths. PNG bytes are written to an in-memory buffer; the renderer never
  constructs a filesystem path and never spawns a shell. A run legitimately named
  `../../etc/passwd` renders as text and does nothing else — `test_hostile_titles_are_inert`.
* No interactive backend, and above all never WebAgg (which would open a socket). `MPLBACKEND=Agg`
  is forced in the package's `__init__` before Matplotlib is imported.
* No network. The worker's `connect-src 'self'` CSP and same-origin vendored assets make the
  runtime fetch nothing it did not ship with.

---

## 4. Development

A pinned virtualenv lives at `poster-renderer/.venv`.

```bash
# Run the suite (also how CI runs it, from the repository root)
poster-renderer/.venv/bin/python -m pytest poster-renderer/tests

# Exercise the real engine — Pyodide in Node — against its committed baseline
pnpm --filter @aat/web test test/ui/poster-engine.test.ts

# Regenerate the browser-side baseline after an intended stack change
node apps/web/scripts/generate-poster-fixture.mjs
```

`requirements.txt` pins Linux wheels only, on purpose: it is the native reference stack's lock
file, not a cross-platform one, and it lists no sdists so an unsupported platform fails loudly
instead of building a subtly different binary. The `.venv` is provisioned with a managed
Python >= 3.12 (e.g. `uv python install 3.13 && uv venv .venv --python 3.13`) plus
`uv pip install --require-hashes -r requirements.txt`.

### Reference images

`tests/reference/aat-poster-v1-gravity-level-72dpi.png` is the preset rendered from the
deterministic fixture in `conftest.py`, committed so a pixel change is something a reviewer can
*look at*.

Only the 72-dpi image is committed. The same figure at the production 300 dpi is ~320 KB and tests
nothing the small one does not — `test_png_pixel_dimensions_follow_dpi_and_figsize` covers dpi
scaling, and a low-dpi render is if anything a *more* sensitive detector of font-rasteriser
changes, because a hinting difference is proportionally larger on a small glyph.

Two guarantees, and the difference between them matters:

* **Byte-identical**, for repeated renders in the same environment. `test_determinism.py` asserts
  this. It is what makes a stored poster's `objectSha256` meaningful and a retry a true no-op.
  Achieved by fixing `MPLBACKEND`, `MPLCONFIGDIR`, the font selection, and the PNG metadata (a
  constant `Software` chunk, no `Creation Time`, no `tIME`).
* **Perceptually identical**, across operating systems and library builds. That is all that can be
  promised: FreeType hinting, zlib compression levels and libpng filter choices differ between
  builds. `test_reference_image.py` asserts identical dimensions plus a tight pixel-difference
  tolerance, which is the portable gate.

Byte equality against the committed reference is available but **opt-in**, via
`POSTER_STRICT_REFERENCE_BYTES=1`, because the committed file was produced on one machine.
Enable it when the reference was regenerated in the exact environment you are testing in — then
it becomes the strictest visual-regression gate available. The browser side has its own byte-exact
anchor: `apps/web/test/fixtures/poster-aat-poster-v1-72dpi-pyodide.png`, asserted unconditionally
because WASM CPython is byte-deterministic across boots.

---

## 5. Related documents

* `packages/plot-spec/` — the spec schema and the TypeScript mirror of the preset
* `docs/supply-chain.md` — why these dependencies never auto-merge
* `docs/poster-renderer.md` — the engine's place in the system and the review procedure
* `docs/web-architecture.md` — where the engine sits, and poster idempotency
* `docs/numerical-compatibility.md` — the bit-equality guarantee for the numbers being drawn
* `/home/user/AAT/gui/plot_controller.py`, `/home/user/AAT/gui/styles.py`,
  `/home/user/AAT/tests/gui/test_export_graph_invariance.py` — the originals
