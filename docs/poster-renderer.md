# The poster renderer

AAT Web draws two completely different kinds of picture, and conflating them is the mistake this
whole component exists to prevent.

The **interactive graph** is drawn in the browser, by uPlot, on a canvas, from downsampled data,
sixty times a second while someone drags a selection. The **formal poster** is drawn by
Matplotlib's Agg backend — also in the browser, inside a dedicated Web Worker running Pyodide
(WASM CPython) — from full-resolution data, once per analysis, and is pixel-compatible with what
the desktop application writes to `results_AAT/graphs/<name>_gl.png`.

Only the second one goes in a paper. This document is about why that split exists, what crosses
the boundary between them, and what keeps the engine's output from drifting.

## Ordinary graphs never leave the browser — and now neither does the poster

The governing principle of the project (`docs/web-architecture.md`) is that local analysis is the
product and the cloud is optional. A graph you cannot see without a network is not an analysis
tool, so every graph the user interacts with is local:

| | Interactive graph | Formal poster |
| --- | --- | --- |
| Drawn by | uPlot, in the main thread | Matplotlib Agg, under Pyodide in a Web Worker |
| Data | min/max-per-pixel decimated | full resolution |
| When | continuously, on every pan, zoom and selection | once per analysis revision, or on request |
| Needs an account | no | no — only storing it in the workspace does |
| Needs a network | no | no — after the first visit, the engine is cached |
| Pixel guarantee | none | byte-identical within a pinned Pyodide build |
| Suitable for publication | no | yes |

The poster used to be the exception: it ran in a Cloudflare Container, so drawing one needed an
account and a network. The container existed for exactly one reason — *there is no Matplotlib in
a browser* — and Pyodide ended that being true. Moving the render into the browser removed the
last cloud dependency from the core workflow, removed a billable service and its whole lifecycle
apparatus (the Durable Object, the state machine, the circuit breaker, the rate limit), and
removed the network round trip between the numbers and the figure.

Sending interactive rendering through the Matplotlib path would still be wrong — it is a
one-shot engine, not a 60 fps one — and `apps/web/src/exporting/png.ts` still copies the uPlot
canvas to a PNG with the same warning in its module doc, in the UI, and in the result toast:

> The two agree on the data and on nothing else: line joins, antialiasing, text shaping and tick
> selection all differ, and they differ *between browsers* as well.
>
> That is fine for a screenshot to paste into a message, and not fine for a figure in a paper.

**The engine does no analysis.** Every number it draws was computed in the browser by
`@aat/analysis-core`, bit-for-bit compatibly with the desktop application (see
`docs/numerical-compatibility.md`). Its whole job is to draw them.

## How the engine runs

`apps/web/src/poster/engine/` boots Pyodide lazily, on the first poster request:

- `pyodide.worker.ts` is a dedicated Web Worker. It loads the vendored Pyodide runtime from
  `/pyodide/<version>/` — same-origin, so `connect-src 'self'` suffices and no CDN is involved
  at runtime — and `import`s nothing else on the critical path.
- `bootPosterEngine` loads the bundled wheels (matplotlib, numpy, pillow), then feeds it the
  render core: the *same* `poster-renderer/src/poster_renderer/` Python sources the pytest
  suite exercises, shipped to the worker as text through `python-sources.ts`. There is one
  implementation, not a port.
- `engine-core.ts` owns the bridge: `render_spec_json` carries a spec in, a `bytes` PNG comes
  out, and `entry.py` is the thin callable the worker posts to.
- `renderer.ts` is the main-thread shell — `renderPosterPng(spec)`, `posterEngineVersion()`,
  and a status feed (`booting → loading → ready`) the UI renders as the poster's
  `Rendering…` state.

The runtime assets are produced by `apps/web/scripts/vendor-poster-assets.mjs`, which fetches
the wheels from the jsdelivr Pyodide mirror at *install/build* time and verifies every file's
sha256 against the `pyodide-lock.json` shipped inside the pinned `pyodide` npm package. The
output — 16 files, ~25.5 MiB — is emitted under `/pyodide/<version>/` at build, so a Pyodide
upgrade is a lockfile change plus a re-vendor, reviewed like any other dependency. The service
worker precaches none of it; a runtime `CacheFirst` route on `^/pyodide/` keeps the second
visit — and everything offline after it — cheap.

Cold start is seconds (WASM bootstrap + wheel install into the in-memory filesystem), paid once
per session on the first render. The engine status feed exists precisely so this is shown as
progress rather than a hang.

## The plot spec is the entire boundary

`packages/plot-spec` defines the only thing that may reach the renderer: a strictly validated,
declarative description of one figure.

The specification is **data, and never anything else**. There is no field that becomes a
callable, a filename, a filesystem path, a shell argument or an rcParams entry. If the renderer
needs something to draw a poster, it must be expressible as a field in `spec.ts`; if it is not
expressible there, it does not reach the renderer at all.

| Field | Type | Bound |
| --- | --- | --- |
| `analysisRevisionId` | string | 1–200 characters |
| `runCode` | string | `/^\d{6}[a-z]?$/` |
| `posterKind` | enum | `auto` \| `custom` |
| `posterPresetVersion` | enum | `aat-poster-v1` |
| `xMin`, `xMax` | finite number | `xMin < xMax` |
| `yMin`, `yMax` | finite number, optional on the wire | `yMin < yMax` when both present; an absent bound is drawn at the preset's, never autoscaled |
| `series` | enum | `inner` \| `drag` \| `both` |
| `title` | string | ≤ 120 characters, no control characters |
| `showLegend` | boolean | |
| `figureWidth`, `figureHeight` | number | 2–20 inches |
| `dpi` | integer | 72–600 |
| `data.inner`, `data.drag` | encoded series pair | exactly the series `series` implies |

Numeric arrays travel as base64 of a little-endian `Float64Array` (`wire.ts`), because JSON has
no NaN — and NaN in a `values` array is the documented "gap" marker, drawn as a break in the line.
The asymmetry is enforced: `time` rejects NaN and ±Infinity outright, because a gap is expressed
by the *value* at an instant being absent, never by the instant itself being undefined; `values`
rejects only ±Infinity, since an infinite gravity level is never legitimate data.

Two independent size caps apply. `MAX_POINTS` (200,000 per array) bounds one series' decoded size
to 1.6 MB, so Matplotlib's per-line vertex count stays predictable. `MAX_PAYLOAD_BYTES`
(8 MiB of base64 characters) bounds the actual JSON body, which is what a transport layer must be
able to reject before it finishes buffering. They are not restatements of one another: four arrays
at exactly 200,000 points each encode to 8,533,344 bytes, which already exceeds the payload cap.

### Validation lives on both sides of the bridge, on purpose

The client validates with Zod (`parsePosterPlotSpec`) before it will hand a spec to the worker.
The Python side validates again from scratch, in `poster_renderer/validation.py`, with every
limit in `poster_renderer/limits.py`. The duplication is the point: **the render core must never
treat its caller as trusted**, even when the caller is the application that loaded it — a spec
can also arrive in the upload body from any client of the Worker's API.

Two mirrors of one contract can drift, so `tests/test_validation.py` asserts each constant by
value against `spec.ts`, and closes two places where Python would otherwise be *laxer* than
JavaScript:

- `json.loads` accepts the bare literals `NaN`, `Infinity` and `-Infinity`. The renderer rejects
  them.
- Python's `\d` matches Unicode decimal digits, so `٢٦٠٨١١` would satisfy an unflagged run-code
  pattern that JavaScript's `\d` would never accept. `RUN_CODE_PATTERN` is compiled with
  `re.ASCII`.

The Worker additionally checks two things the schema cannot: that `spec.analysisRevisionId` names
the revision in the URL, and that `spec.posterKind` matches the endpoint. Letting them differ
would file a figure of one measurement under another — a provenance failure, not a formatting one.

## What the Worker accepts now

Since the figure arrives already drawn, the cloud side is an upload endpoint, not a render
service. `POST /revisions/:id/poster/auto` and `POST /revisions/:id/posters` take
`{ spec, pngBase64, engineVersion? }` and apply the checks that remain meaningful:

- the spec parses and passes the cross-checks above;
- `pngBase64` is strict base64, decodes under `AAT_MAX_POSTER_BYTES`, and begins with the PNG
  signature — the Worker does not decode the image, but it refuses to store anything that is
  not one;
- the owner's quota covers the bytes (the poster is recorded against the *revision's owner*,
  which `docs/cloud-data-model.md` explains);
- `engineVersion` is recorded as `poster_figures.renderer_version` — provenance only.

What is gone: the render queue, the `queued → rendering → ready | failed` state machine and its
conditional UPDATEs, the stale-render takeover, `POSTER_BUSY`, the Durable Object, the circuit
breaker, and the per-user poster rate limit. A `poster_figures` row is written `status: 'ready'`
with its `object_id` in one pass, because a PNG either arrived or it did not — there is nothing
to wait in and nothing to fail at. The status vocabulary is unchanged in the schema and in
`@aat/plot-spec`, so rows from the container era still read; only the Worker no longer writes
the other three values.

This is also what makes the automatic poster idempotent without a queue: `poster_figures_auto_unique`
still claims `kind = 'auto'` once per `(analysis_revision_id, preset_version)`, and a repeat call
returns the existing figure with `created: false`. A double-submit, a reload mid-upload and two
devices still produce one stored poster.

## The visual contract is frozen, and every constant was read rather than guessed

`aat-poster-v1` reproduces the desktop application's export path
(`gui/plot_controller.py::plot_gravity_level`, the `save_graph` branch) constant by constant. The
preset lives in two mirrored places — `poster-renderer/src/poster_renderer/preset.py` for the
renderer and `packages/plot-spec/src/presets.ts` for the browser — and
`poster-renderer/README.md` carries the full property-by-property table with its desktop sources.

The one-line summary: white figure and axes, Inner Capsule `#0969DA`, Drag Shield `#CF222E`,
line width `0.8`, dashed grid at alpha `0.3` in `#656D76`, spines `#D0D7DE`, title
`The Gravity Level <name>`, an `AAT v11.1.0` watermark at axes fraction `(0.98, 0.02)`, and a
default geometry of 10.6 × 3.4 inches at 300 dpi over `0 .. 1.45 s`.

Changing any of it changes the pixels of every future poster. `posterPresetContentHash` exists so
an accidental edit to `aat-poster-v1` fails a test rather than quietly reshaping a decade of
figures.

### Two details that are easy to get wrong

**The figure is laid out at 100 dpi and rasterised at 300.** The desktop builds its export figure
with `plt.figure(figsize=(w, h))` and no `dpi`, so it carries Matplotlib's default `figure.dpi` of
100. `tight_layout()` measures text with a renderer at *that* dpi and bakes the resulting subplot
geometry in; only afterwards does `savefig(dpi=300)` rasterise. Constructing the figure at 300
would lay the axes out against differently-rounded text extents and shift every element.
`preset.LAYOUT_DPI` exists for this and must not be "simplified".

**The PNG metadata is a fixed string.** Matplotlib would otherwise write a `Software` chunk naming
its own version, so a Matplotlib upgrade would change the PNG bytes even when not a single pixel
moved. `render.PNG_METADATA` writes one constant `Software` value, and no `Creation Time` and no
`tIME` chunk — so two renders a day apart still match.

## What is pinned, and what each pin protects

The renderer now has two dependency stacks, and they are pinned for different reasons:

| Stack | Pinned where | What it is for |
| --- | --- | --- |
| **Pyodide wheels** — matplotlib 3.10.8, numpy 2.4.6, pillow 12.2.0, inside Pyodide 314.0.7 | `pyodide` npm package in `pnpm-lock.yaml`; `pyodide-lock.json` sha256 per wheel, verified by `vendor-poster-assets.mjs` | What the browser actually draws with |
| **Native reference** — matplotlib 3.11.2, numpy 2.5.3, pillow 12.3.0 | `poster-renderer/requirements.txt`, `--require-hashes` | The pytest suite's desktop-parity oracle |

The native pins are deliberately *not* the browser's versions: Pyodide publishes its own wheels,
and requirements.txt keeps tracking the desktop application's resolution so the reference tests
keep comparing the render core against the desktop's actual stack. A native bump that would
re-sync the two is a requirements.txt change; a Pyodide bump is an npm change — either way, the
pixel review below applies.

FreeType and DejaVu Sans travel *inside* each Matplotlib wheel in both stacks, so the glyph
rasteriser and the glyphs are pinned by the same mechanism as the library. `MPLBACKEND`,
`MPLCONFIGDIR` (an in-memory path under Pyodide), the font selection and the PNG metadata are all
fixed inside `render.py`, which is what makes a second render of the same spec byte-identical.

## The automatic poster: exactly one per (revision, preset version)

An authenticated analysis produces one automatic formal poster. Not one per page load, not one per
gallery render, not one per zoom.

Idempotency is a **partial unique index in D1**, not a client-side check:

```sql
CREATE UNIQUE INDEX `poster_figures_auto_unique`
  ON `poster_figures` (`analysis_revision_id`,`preset_version`) WHERE kind = 'auto';
```

`POST /api/v1/revisions/:revisionId/poster/auto` claims the figure with
`INSERT ... ON CONFLICT DO NOTHING`. Exactly one caller inserts a row; everyone else gets zero rows
affected and reads back the row that already exists. A double-submitted request, a reload halfway
through, and the same user on two devices all produce one poster and one stored PNG.

Crucially, a *repeat* call after the poster is ready uploads nothing and renders nothing — it
returns the existing figure with `created: false`.

**There is no queue and no Workflow.** The browser draws locally and calls an idempotent endpoint
after the revision and snapshot are persisted. An interrupted upload is safe to retry. Adding a
queue would add moving parts to a workload that is one stored figure per analysis.

## The custom selected-range poster

`POST /api/v1/revisions/:revisionId/posters` stores a hand-configured figure, with
`posterKind: 'custom'`. It is deliberately **not** idempotent: a researcher adjusting the axis
bounds and re-rendering is asking for a different picture each time, and collapsing those onto one
row would destroy the variant they just made.

Custom figures are excluded from the uniqueness constraint by its `WHERE kind = 'auto'` clause, so
a revision may carry one automatic poster and as many custom ones as its owner draws — bounded by
`AAT_MAX_POSTER_BYTES` per figure and the owner's storage quota, which are the only resources a
stored PNG spends.

The natural custom poster is the user's selected range: `xMin`/`xMax` set from the selection
rather than from the preset's `0 .. 1.45 s` default, optionally with a `yMin`/`yMax` of the
researcher's own — the dialog prefills those two fields from the local `ylim_min`/`ylim_max`, so
the figure starts out framed the way the graph on screen is framed, as it is on the desktop.

**The y-range is never absent from the figure.** It is optional on the *wire* — `spec.ts` has
always allowed it to be omitted, and specs stored before the builder began resolving it still
are — but both the builder and the renderer fall back to the preset's `-1 .. 1 G`
(`config.default.json`'s `ylim_min`/`ylim_max`), never to Matplotlib's autoscaling.
`plot_gravity_level` calls `set_ylim(config["ylim_min"], config["ylim_max"])` unconditionally on
both the screen axes and the export axes; the desktop has no autoscaling branch for a
gravity-level figure, so neither does this. An autoscaled poster is the failure mode worth
naming: it renders beautifully, and it frames a clean 5 mG drop and a spoiled 400 mG drop into
identical-looking plateaus that differ only in their tick labels — defeating the comparison a
reader of a poster is most likely to make by eye. This was a real defect, fixed in
`aat-poster-v1` rather than deferred to a `v2`; the reasoning is in `packages/plot-spec/test/presets.test.ts`
next to the pinned preset hash.

`title` is the one place the engine interprets rather than transcribes. The desktop draws its
CSV basename — which for this project *is* the run code — into the title and both legend labels,
one name in three places. So an empty `title` means "use `runCode`", giving exactly the desktop's
figure; a non-empty `title` replaces the *name*, not the title format. The title still reads
`The Gravity Level <name>`, because a formal poster's title format is part of what makes it
formal. This is isolated in `PosterPlotSpec.display_name` so reconciling it with the Worker is a
one-line change.

## Preset versioning

`POSTER_PRESET_VERSIONS` currently holds one entry, `aat-poster-v1`, and
`DEFAULT_POSTER_PRESET_VERSION` names the preset new figures are rendered with. The default is
written as a literal rather than derived from the end of the array on purpose: adding a version
must never be the thing that changes the style of every new figure. A `v2` should exist for a
while before it becomes the default — long enough to render both and compare them — and promoting
it is then a one-line, reviewable change.

The versioning rule itself is short:

> If the contract itself is meant to change — a new colour, a new layout — that is not an edit to
> `aat-poster-v1`. It is a new preset version, so posters already stored keep rendering the way
> they always have.

Three columns carry the provenance forward. `poster_figures.preset_version` records which preset
drew a figure; `poster_figures.spec_hash` records the canonical SHA-256 of the exact spec that was
sent; `poster_figures.renderer_version` records which engine build drew it — the client sends
`posterEngineVersion()` (`pyodide-314.0.7/matplotlib-3.10.8/numpy-2.4.6/pillow-12.2.0`) in the
upload body. `poster_presets` registers each `(preset_key, preset_version)` with its `spec_hash`
and `renderer_version`, so a figure can always be explained by the preset that produced it even
after the preset registry has moved on.

Note that `RENDERER_VERSION` and `DESKTOP_BASELINE_VERSION` are deliberately different strings,
and that neither of them is AAT Web's own version (`1.0.0`). They answer three separate questions:

| Constant | Value | Answers |
| --- | --- | --- |
| `DESKTOP_BASELINE_VERSION` | `11.1.0` | Which AAT release's figure is this? — *drawn into the watermark*, so bumping it is a visual-contract change |
| `RENDERER_VERSION` | `aat-poster-renderer/1.2.0` | Which render core drew it? — carried by the render core itself; moves no pixel |
| `APP_VERSION` (`apps/web`) | `1.0.0` | Which AAT Web build asked for it? — never reaches the render core; recorded against the analysis revision |

A figure therefore says `AAT v11.1.0` while the application that produced it is AAT Web 1.0.0.
That is the designed state, not a drift: see `docs/versioning.md`, "Why the figure's version is
not AAT Web's version".

## The visual-regression suite has two anchors now

`poster-renderer/tests/reference/aat-poster-v1-gravity-level-72dpi.png` is the preset rendered
from the deterministic fixture in `conftest.py` — a seeded `np.random.RandomState(20260725)`
signal that mirrors the desktop suite's `deterministic_data` fixture, using the legacy generator
precisely because NumPy's compatibility policy freezes its stream forever. The reference is
committed so a pixel change is something a reviewer can *look at*, not only a failed assertion
about a hex colour.

Only the 72 dpi image is committed. The same figure at the production 300 dpi is ~320 KB and tests
nothing the small one does not — and a low-dpi render is if anything a *more* sensitive detector of
font-rasteriser changes, because a hinting difference is proportionally larger on a small glyph.

### Anchor 1 — perceptual vs the desktop reference (native pytest)

`test_reference_matches_current_render` asserts what has to hold between the render core and the
frozen desktop figure, in whatever environment the suite runs:

| Assertion | Value |
| --- | --- |
| Image dimensions | exactly 763 × 244 (10.6 × 3.4 in at 72 dpi) |
| Mean absolute per-channel difference | ≤ 1.0 of 255 |
| Share of pixels differing by more than 16 levels | ≤ 2% |

Byte equality is deliberately *not* asserted here. FreeType's rasteriser and hinting differ
between builds, and zlib and libpng make different compression choices, so demanding exact bytes
would fail on a developer's Mac — or under Pyodide — for reasons that have nothing to do with the
contract. Geometry is the sharp part of this tier: a changed figure size is reported as "figure
geometry changed — this is a visual-contract break" rather than as a tolerance overrun.

**Known state:** the pinned Pyodide wheels (matplotlib 3.10.8 vs the reference's 3.11.2) currently
land *outside* this tier's tolerances against the desktop reference — mean abs diff ≈ 4.90/255,
≈ 8.7% of pixels over 16 levels — all of it antialiasing intensity, with no geometry drift and
data agreeing to ~1 ULP. That is why the second anchor exists and why `RENDERER_VERSION` moved to
1.2.0: the engine is honest about which stack drew the figure. Whether a future Pyodide bundles a
matching matplotlib is a question for the dependency-review procedure below.

### Anchor 2 — byte-exact vs the Pyodide baseline (vitest, real Pyodide)

`apps/web/test/fixtures/poster-aat-poster-v1-72dpi-pyodide.png` is the same spec rendered through
the actual engine — real Pyodide, real WASM, in a vitest — and
`apps/web/test/ui/poster-engine.test.ts` asserts **byte equality** against it. That demand is
honest in exactly one place: WASM CPython is deterministic across boots and machines, so a byte
difference can only mean the bundled wheels moved, the render core moved, or the fixture is
stale. The fixture is regenerated only by `apps/web/scripts/generate-poster-fixture.mjs` — never
hand-edited, and only ever committed together with the change that moved the bytes.

Together the two anchors bracket the guarantee the container suite needed two tiers for: the
first says *this is still the desktop's figure* (perceptually), the second says *the deployed
engine draws exactly these bytes* (literally).

### A third guarantee, distinct from both

`test_determinism.py` asserts that repeated renders of the same spec in the same environment are
**byte-identical**, that the bytes depend on the spec's content rather than on the object that
carried it, that no timestamp is written, and — importantly — that changing any field *does*
change the bytes. Determinism must not be indifference.

That is what makes a stored poster's SHA-256 meaningful and a retry a true no-op. It is achieved
by fixing `MPLBACKEND`, `MPLCONFIGDIR`, the font selection and the PNG metadata, and it is a
different claim from either anchor: those compare against a committed past, this one compares a
render against itself.

Alongside these, `test_visual_contract.py` (15 tests, a port of the desktop suite's
`test_export_graph_invariance.py`) asserts the preset's constants directly — geometry, colours,
line widths, legend frame, spines, ticks, grid, watermark placement, `savefig` arguments, that the
font is pinned rather than discovered, that the backend is Agg, and that output does not move when
Matplotlib's ambient rcParams are set to a full dark palette.

## Reviewing a Matplotlib, Pyodide or render-core change

Renovate labels every `poster-renderer/**` update — and the `pyodide` npm package — `visual-contract`
/ `needs-visual-review` and excludes it from auto-merge **at every update type, including patch**
(`renovate.json5`; see `docs/supply-chain.md`). A patch bump that moves a tick label by one pixel
silently invalidates the guarantee this engine exists to provide, so there is no update size small
enough to skip this.

1. **Take the update on a branch.**
2. **Run the native suite:**
   ```bash
   poster-renderer/.venv/bin/python -m pytest poster-renderer/tests -q
   ```
   A tolerances failure here means the render core or the native reference stack moved against
   the *desktop* figure — look at the two images before anything else. Regenerate the reference
   only deliberately:
   ```bash
   poster-renderer/.venv/bin/python -m pytest \
     poster-renderer/tests/test_reference_image.py --update-reference
   ```
3. **Run the engine suite:**
   ```bash
   pnpm --filter @aat/web test test/ui/poster-engine.test.ts
   ```
   A byte mismatch means the *browser's* stack moved. If the change is the one you intended (a
   Pyodide bump), regenerate the baseline:
   ```bash
   node apps/web/scripts/generate-poster-fixture.mjs
   ```
   and confirm the diff is antialiasing-class noise rather than geometry — the native suite's
   tolerances are the yardstick, not your eyes alone.
4. **Commit the regenerated fixture(s) *with* the dependency bump, in the same commit**, so the
   pixel change and its cause are inseparable in the history.
5. **If the contract itself is meant to change, do not edit `aat-poster-v1`.** Add a new preset
   version — in `presets.ts` and `preset.py` together — and register it. Stored posters must keep
   rendering the way they always have.

A change to `version.py`'s `DESKTOP_BASELINE_VERSION` follows the same procedure, because it is
drawn into the watermark. A change to `RENDERER_VERSION` does not move a pixel, but it does change
which bytes the engine reports — bump it whenever a change *could* move bytes, per the comment in
`version.py`.

## Outstanding

- ~~**No poster UI exists.**~~ The analyzer now carries one: `apps/web/src/poster/` mints
  full-resolution sources from the analysed dataset, draws the figure locally, asks for the
  automatic figure once per revision as soon as the snapshot is stored, shows its status and the
  rendered PNG, and offers `正式ポスター図を作成` for the selected range through a review dialog
  whose every bounded choice comes from `@aat/plot-spec`'s form helpers. Reading a poster never
  draws one: the panel only ever issues `GET /revisions/:id/posters` and
  `GET /posters/:id/image`. The Run Gallery's own poster screens are a separate surface.
- **`poster_presets` is not populated by anything.** The table and its uniqueness constraint exist,
  but no code path inserts the registry rows, so preset provenance currently lives only on the
  individual `poster_figures` rows.
- **Pyodide's bundled matplotlib is not the desktop's version.** Anchor 1 is satisfied perceptually
  but not at its written tolerances today (see above). Closing that gap wants either a Pyodide
  build bundling matplotlib 3.11.x or an accepted re-baseline of the desktop reference — a
  policy decision, not a defect to patch around.

## Related documents

- `poster-renderer/README.md` — the property-by-property contract table and the render core's own configuration
- `packages/plot-spec/src/spec.ts` — the schema, with the reasoning for each limit
- `docs/web-architecture.md` — where the engine sits in the system
- `docs/numerical-compatibility.md` — the bit-equality guarantee for the numbers being drawn
- `docs/supply-chain.md` — why these dependencies never auto-merge
- `docs/cost-controls.md` — what removing the container changed about spend
