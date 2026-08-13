# The poster renderer

AAT Web draws two completely different kinds of picture, and conflating them is the mistake this
whole component exists to prevent.

The **interactive graph** is drawn in the browser, by uPlot, on a canvas, from downsampled data,
sixty times a second while someone drags a selection. The **formal poster** is drawn by
Matplotlib's Agg backend inside a pinned container, from full-resolution data, once per analysis,
and is pixel-compatible with what the desktop application writes to
`results_AAT/graphs/<name>_gl.png`.

Only the second one goes in a paper. This document is about why that split exists, what crosses
the boundary between them, and what keeps the container's output from drifting.

## Ordinary graphs never leave the browser

The governing principle of the project (`docs/web-architecture.md`) is that local analysis is the
product and the cloud is optional. A graph you cannot see without a network is not an analysis
tool, so every graph the user interacts with is local:

| | Interactive graph | Formal poster |
| --- | --- | --- |
| Drawn by | uPlot, in the main thread | Matplotlib Agg, in a Cloudflare Container |
| Data | min/max-per-pixel decimated | full resolution |
| When | continuously, on every pan, zoom and selection | once per analysis revision, or on request |
| Needs an account | no | yes |
| Needs a network | no | yes |
| Pixel guarantee | none | byte-identical within the pinned image |
| Suitable for publication | no | yes |

Sending interactive rendering to the container would be wrong three times over. It would make the
core of the application depend on a network round trip, breaking the offline guarantee. It would
turn a drag gesture into a stream of container invocations, which is the render storm that
`max_instances: 1` and the rate limit exist to make impossible. And it would be slower than the
canvas by orders of magnitude for a picture nobody keeps.

Rendering *posters* in the browser would be wrong for a different reason: there is no Matplotlib
in a browser. `apps/web/src/exporting/png.ts` can copy the uPlot canvas to a PNG, and it carries
this warning in its module doc, in the UI at the point of export, and in the result toast:

> The two agree on the data and on nothing else: line joins, antialiasing, text shaping and tick
> selection all differ, and they differ *between browsers* as well.
>
> That is fine for a screenshot to paste into a message, and not fine for a figure in a paper.

So the container is not a performance optimisation and not a convenience. It is the only place in
AAT Web where a figure carrying a pixel-level compatibility guarantee can be produced, and it is
kept as narrow as possible so that guarantee is cheap to hold.

**The container does no analysis.** Every number it draws was computed in the browser by
`@aat/analysis-core`, bit-for-bit compatibly with the desktop application (see
`docs/numerical-compatibility.md`). Its whole job is to draw them.

## The plot spec is the entire boundary

`packages/plot-spec` defines the only thing the browser may send the renderer: a strictly
validated, declarative description of one figure.

```
POST /render    application/json  ->  image/png
GET  /health                      ->  application/json
```

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
| `yMin`, `yMax` | finite number, optional | `yMin < yMax` when both present |
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

### The spec is validated twice, on purpose

The Worker validates with Zod (`parsePosterPlotSpec`) before it will call the container. The
container then validates again from scratch, in `poster_renderer/validation.py`, with every limit
in `poster_renderer/limits.py`. The duplication is the point: **a container must never treat its
caller as trusted**, even when the caller is a Worker in the same account.

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

| Pinned thing | Where | Why it moves pixels |
| --- | --- | --- |
| Base image | `Dockerfile`, by **digest** | Ships zlib and libpng; a rebuild can change PNG bytes |
| Python 3.12 | base image | Float formatting feeds tick labels |
| matplotlib 3.11.1 | `requirements.txt`, by hash | The layout engine and the whole drawing stack |
| numpy 2.5.1 | `requirements.txt`, by hash | Tick locators, and the arrays being drawn |
| Pillow 11.3.0 | `requirements.txt`, by hash | Since Matplotlib 3.3, the PNG encoder itself |
| FreeType | *inside the Matplotlib wheel* | Glyph rasterisation and hinting |
| DejaVu Sans | *inside the Matplotlib wheel* | The glyphs |
| `APP_VERSION = "11.1.0"` | `version.py` | Drawn into the watermark |

matplotlib 3.11.1 and numpy 2.5.1 are what the desktop application's `uv.lock` resolves for
Python ≥ 3.12. That equality is the entire point.

Three mechanisms hold the pins:

- **The base image is referenced by digest, not tag.** `python:3.12-slim-bookworm` is republished
  whenever Debian or CPython gets a patch, and a rebuilt FreeType or zlib can change rendered
  bytes. The tag is kept beside the digest for human readability only.
- **`pip install --require-hashes`** makes pip refuse the entire file unless every requirement —
  direct *and* transitive — is pinned with a hash. That is why packages nobody imports (contourpy,
  kiwisolver, six) are listed: leaving one unpinned would disable hash checking for all of them.
- **`--only-binary=:all:`** refuses to build anything from source.

That last flag is what makes the FreeType and font rows of the table work. **FreeType and DejaVu
Sans are not separate dependencies.** They are compiled and bundled into the Matplotlib manylinux
wheel. Pinning Matplotlib therefore pins the glyph rasteriser and the glyphs, which is why the
image installs **no system font package at all** and needs no fontconfig. A locally built
Matplotlib would link whatever FreeType the build host had and render different glyphs — so
building from source is refused rather than discouraged.

Two more image-level details serve the same guarantee. `MPLCONFIGDIR` points at a directory the
unprivileged `poster` user owns, and the Dockerfile draws one throwaway figure at build time so
the font cache is written *into the image*: no request ever pays for a font scan, no runtime write
is needed, and a pinned stack that cannot rasterise text fails the build rather than the first
render. And the sample-data directory is the only thing pruned — deleting fonts to save a few
hundred kilobytes would put the font manager one upgrade away from resolving a different face, and
deleting `__pycache__` would make every worker respawn recompile Matplotlib, which is exactly the
path a render timeout takes.

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
through, and the same user on two devices all produce one poster and one render.

Crucially, a *repeat* call after the poster is ready renders nothing — it returns the existing
figure with `created: false`. So does a call while a render is in flight, and so does a call
against a figure that has already failed. A failed figure is retried only through the explicit
retry endpoint, so a client polling the automatic endpoint cannot turn a persistent renderer fault
into a render loop.

A figure moves through `queued → rendering → ready | failed` via conditional UPDATEs
(`claimForRender`), so two requests that both read `queued` cannot both start a render: one
transitions, the other sees zero rows affected and backs off. A render abandoned by an evicted
Worker is reclaimed by `takeOverStaleRender` after `AAT_RENDER_STALE_SECONDS` (300 s), which stops
one orphaned row from blocking every future render forever.

**There is no queue and no Workflow.** The browser calls an idempotent endpoint after the revision
and snapshot are persisted; when the renderer cannot take work the answer is `POSTER_BUSY` —
backpressure the browser retries later — never a queued job that costs container time nobody is
waiting for. Adding a queue would add moving parts to a workload that is one render per analysis.

## The custom selected-range poster

`POST /api/v1/revisions/:revisionId/posters` renders a hand-configured figure, with
`posterKind: 'custom'`. It is deliberately **not** idempotent: a researcher adjusting the axis
bounds and re-rendering is asking for a different picture each time, and collapsing those onto one
row would destroy the variant they just made.

Custom figures are excluded from the uniqueness constraint by its `WHERE kind = 'auto'` clause, so
a revision may carry one automatic poster and as many custom ones as its owner renders — subject
to the same rate limit, the same concurrency cap and the same circuit breaker as everything else.

The natural custom poster is the user's selected range: `xMin`/`xMax` set from the selection
rather than from the preset's `0 .. 1.45 s` default, optionally with explicit `yMin`/`yMax`. An
absent y bound leaves Matplotlib's autoscaling in charge of that side, which is why the frozen
preset has defaults for the figure geometry and the x-range but none for y.

`title` is the one place the container interprets rather than transcribes. The desktop draws its
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
sent; `poster_figures.renderer_version` records the container build that answered, taken from the
`X-Poster-Renderer-Version` response header. `poster_presets` registers each `(preset_key,
preset_version)` with its `spec_hash` and `renderer_version`, so a figure can always be explained
by the preset that produced it even after the preset registry has moved on.

Note that `RENDERER_VERSION` and `APP_VERSION` are deliberately different strings.
`APP_VERSION` (`11.1.0`) is *drawn into the watermark*, so bumping it changes every pixel of that
text and is a visual-contract change. `RENDERER_VERSION`
(`aat-poster-renderer/1.0.0`) is build identity only: it appears in `GET /health`, in the response
header and in the PNG's `Software` text chunk, and changing it moves no pixel.

## The container is short-lived on purpose

The renderer runs behind a Durable Object, `PosterRendererContainer`, which is the only thing that
talks to it. Two mechanisms keep the steady state at "not running", and both are cost guards
rather than performance tuning — see `docs/cost-controls.md`:

| Mechanism | Value | Where |
| --- | --- | --- |
| Maximum concurrent instances | `max_instances: 1` | `wrangler.jsonc` |
| Instance shape | `instance_type: "lite"` | `wrangler.jsonc` |
| Idle teardown | `POSTER_RENDERER_SLEEP_AFTER_MS = 60_000` | `container/poster-renderer.ts` |
| Startup wait before shedding load | `STARTUP_TIMEOUT_MS = 45_000` | same |
| Ceiling on one render | `RENDER_TIMEOUT_MS = 60_000` | same |
| The container's own render deadline | `POSTER_RENDER_TIMEOUT_SECONDS = 30` | `poster_renderer/worker.py` |

The sleep-after timeout lives in code rather than in `wrangler.jsonc` because Wrangler's container
schema has no such field — it is a property of the `Container` class in `@cloudflare/containers`,
which this project deliberately does not depend on (one fewer package on a path that can spend
money). It is implemented with a Durable Object alarm, rescheduled on every request, so a burst of
renders keeps the container alive and an idle one goes away.

The Durable Object forwards only `/render` and `/health`; anything else is refused there rather
than handed to the container to reject. The container is started with `enableInternet: false` —
the renderer takes its input in the request body and needs no outbound network, so denying it one
removes exfiltration as a possibility rather than as a policy.

**Cold starts are expected, not errors.** Starting a Python + Matplotlib container takes seconds.
The Durable Object polls `/health` rather than assuming readiness, and a startup that does not
complete inside 45 s is answered `POSTER_BUSY` (HTTP 429) — backpressure, not a failed render.

Inside the container, renders run one at a time in a persistent `spawn`ed subprocess with a
waiting room of `POSTER_MAX_QUEUED` (default **0**). A request that finds the slot busy is refused
immediately with 429 rather than queued. The subprocess is what makes the deadline truthful: a
Matplotlib render is a long call into C and cannot be interrupted in-process, so when the deadline
expires the process is killed and its memory really is released. The same isolation means a
segfault in Agg or FreeType costs one request, not the service.

## The visual-regression suite has two tiers

`tests/reference/aat-poster-v1-gravity-level-72dpi.png` is the preset rendered from the
deterministic fixture in `conftest.py` — a seeded `np.random.RandomState(20260725)` signal that
mirrors the desktop suite's `deterministic_data` fixture, using the legacy generator precisely
because NumPy's compatibility policy freezes its stream forever. The reference is committed so a
pixel change is something a reviewer can *look at*, not only a failed assertion about a hex colour.

Only the 72 dpi image is committed. The same figure at the production 300 dpi is ~320 KB and tests
nothing the small one does not — and a low-dpi render is if anything a *more* sensitive detector of
font-rasteriser changes, because a hinting difference is proportionally larger on a small glyph.

### Tier 1 — perceptual, portable, always on

`test_reference_matches_current_render` asserts what actually has to hold everywhere:

| Assertion | Value |
| --- | --- |
| Image dimensions | exactly 763 × 244 (10.6 × 3.4 in at 72 dpi) |
| Mean absolute per-channel difference | ≤ 1.0 of 255 |
| Share of pixels differing by more than 16 levels | ≤ 2% |

Byte equality is deliberately *not* asserted here. FreeType's rasteriser and hinting differ
between builds, and zlib and libpng make different compression choices, so demanding exact bytes
would fail on a developer's Mac for reasons that have nothing to do with the contract. Geometry is
the sharp part of this tier: a changed figure size is reported as "figure geometry changed — this
is a visual-contract break" rather than as a tolerance overrun.

This tier runs on the CI host (`python3 -m pytest poster-renderer/tests -q`) and in the deploy
workflow's `verify` job.

### Tier 2 — byte-exact, inside the image

`test_reference_is_byte_identical` is skipped unless `POSTER_STRICT_REFERENCE_BYTES=1`. CI sets it
for the run *inside the built image*:

```yaml
- name: Renderer tests inside the image
  run: |
    docker run --rm --network none \
      --env POSTER_STRICT_REFERENCE_BYTES=1 \
      aat-poster-renderer:ci \
      python -m pytest /app/tests -q
```

This is the one place the strict form can honestly be demanded. Inside the image nothing the test
depends on is free to vary: the base is pinned by digest and every wheel by hash, so the renderer,
the glyph rasteriser and the PNG encoder are the exact ones that produced the committed reference.
The suite reports **193 passed** with the flag set, and **192 passed with 1 skipped** without it —
the single difference being this test.

The two tiers are complementary, and the pair of results is the signal:

| Tier 1 (host) | Tier 2 (in image) | What it means |
| --- | --- | --- |
| pass | pass | Nothing moved. |
| pass | **fail** | The pinned stack moved — a wheel, the base image, or the reference is stale relative to the image. This is the case the strict tier exists to catch. |
| **fail** | fail | Something visible changed. Look at the images. |
| **fail** | pass | The CI runner's own libraries drifted; the contract itself is intact. |

Requiring bytes everywhere would have collapsed the second row into noise. Requiring only
perception would have lost it entirely.

### A third guarantee, distinct from both

`test_determinism.py` asserts that repeated renders of the same spec in the same environment are
**byte-identical**, that the bytes depend on the spec's content rather than on the object that
carried it, that no timestamp is written, and — importantly — that changing any field *does*
change the bytes. Determinism must not be indifference.

That is what makes a stored poster's SHA-256 meaningful and a retry a true no-op. It is achieved
by fixing `MPLBACKEND`, `MPLCONFIGDIR`, the font selection and the PNG metadata, and it is a
different claim from either regression tier: those compare against a committed past, this one
compares a render against itself.

Alongside these, `test_visual_contract.py` (13 tests, a port of the desktop suite's
`test_export_graph_invariance.py`) asserts the preset's constants directly — geometry, colours,
line widths, legend frame, spines, ticks, grid, watermark placement, `savefig` arguments, that the
font is pinned rather than discovered, that the backend is Agg, and that output does not move when
Matplotlib's ambient rcParams are set to a full dark palette.

## Reviewing a Matplotlib, font or base-image change

Renovate labels every `poster-renderer/**` update `visual-contract` / `needs-visual-review` and
excludes it from auto-merge **at every update type, including patch** (`renovate.json5`; see
`docs/supply-chain.md`). A patch bump that moves a tick label by one pixel silently invalidates the
guarantee this container exists to provide, so there is no update size small enough to skip this.

1. **Take the update on a branch.**
2. **Run the suite on the host:**
   ```bash
   poster-renderer/.venv/bin/python -m pytest poster-renderer/tests -q
   ```
3. **Build the image and run the suite inside it, strictly:**
   ```bash
   docker build -t aat-poster-renderer:review poster-renderer
   docker run --rm --network none \
     --env POSTER_STRICT_REFERENCE_BYTES=1 \
     aat-poster-renderer:review python -m pytest /app/tests -q
   ```
   Read the two results against the table above before doing anything else. A tier-2-only failure
   means the pinned stack moved, which is exactly the finding this review is for.
4. **If the reference check fails, look at the two images.** Regenerate with
   ```bash
   poster-renderer/.venv/bin/python -m pytest \
     poster-renderer/tests/test_reference_image.py --update-reference
   ```
   open both, and decide whether the difference is acceptable. Regenerating a reference to make a
   test pass, without looking at it, defeats every other safeguard in this directory.
5. **If it is acceptable, commit the regenerated reference *with* the dependency bump, in the same
   commit**, so the pixel change and its cause are inseparable in the history. Regenerate it inside
   the image if the strict tier is to keep passing.
6. **If the contract itself is meant to change, do not edit `aat-poster-v1`.** Add a new preset
   version — in `presets.ts` and `preset.py` together — and register it. Stored posters must keep
   rendering the way they always have.

A change to `version.py`'s `APP_VERSION` follows the same procedure, because it is drawn into the
watermark. A change to `RENDERER_VERSION` does not, because it is not.

## Outstanding

- ~~**No poster UI exists.**~~ The analyzer now carries one: `apps/web/src/poster/` mints
  full-resolution sources from the analysed dataset, asks for the automatic figure once per revision
  as soon as the snapshot is stored, shows its status and the rendered PNG, and offers
  `正式ポスター図を作成` for the selected range through a review dialog whose every bounded choice
  comes from `@aat/plot-spec`'s form helpers. Reading a poster never starts a render: the panel only
  ever issues `GET /revisions/:id/posters` and `GET /posters/:id/image`. The Run Gallery's own poster
  screens are a separate surface.
- **`poster_presets` is not populated by anything.** The table and its uniqueness constraint exist,
  but no code path inserts the registry rows, so preset provenance currently lives only on the
  individual `poster_figures` rows.
- **The container image tag in `wrangler.jsonc` is kept in step by hand.** Wrangler performs no
  environment-variable substitution in that file, so the digest the deploy job captures in
  `POSTER_RENDERER_IMAGE` cannot be injected into the config; the tag there and the tag CI pushes
  have to be kept aligned deliberately.

## Related documents

- `poster-renderer/README.md` — the property-by-property contract table, the error codes, and the service's own configuration
- `packages/plot-spec/src/spec.ts` — the schema, with the reasoning for each limit
- `docs/web-architecture.md` — where the renderer sits in the system
- `docs/numerical-compatibility.md` — the bit-equality guarantee for the numbers being drawn
- `docs/supply-chain.md` — why these dependencies never auto-merge
- `docs/cost-controls.md` — the container lifecycle as a spend guard
