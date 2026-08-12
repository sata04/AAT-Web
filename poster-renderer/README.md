# poster-renderer

The canonical formal-poster renderer for AAT Web: a small Python + Matplotlib service that turns
an already-analysed numeric series and a declarative plot specification into a PNG.

It runs as a Cloudflare Container. It performs **no analysis** — every number it draws was
computed by `packages/analysis-core` in the browser, bit-for-bit compatibly with the desktop
application (see `docs/numerical-compatibility.md`). Its one job is to be the *only* place in AAT
Web where a formal research figure is drawn, so that figure looks the same today, next year, and
on every machine.

```
POST /render    application/json  ->  image/png
GET  /health                      ->  application/json
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

This is the one place where the container's reading of `packages/plot-spec` is an interpretation
rather than a transcription. It is isolated in `PosterPlotSpec.display_name` so that reconciling
it with the Worker is a one-line change.

---

## 2. Why the versions are pinned

| Pinned thing | Where | Why it moves pixels |
| --- | --- | --- |
| Base image | `Dockerfile`, by **digest** | Ships zlib and libpng; a rebuild can change PNG bytes |
| Python 3.12 | base image | Float formatting and stdlib behaviour feed tick labels |
| matplotlib 3.11.1 | `requirements.txt` | The layout engine and the entire drawing stack |
| numpy 2.5.1 | `requirements.txt` | Tick locators, and the arrays being drawn |
| Pillow 11.3.0 | `requirements.txt` | Since Matplotlib 3.3 the PNG encoder itself |
| FreeType | inside the Matplotlib wheel | Glyph rasterisation and hinting |
| DejaVu Sans | inside the Matplotlib wheel | The glyphs |

matplotlib 3.11.1 and numpy 2.5.1 are what `/home/user/AAT/uv.lock` resolves for Python >= 3.12 —
the desktop application's own versions. That equality is the whole point.

Note the last two rows: FreeType and the font are *not* separate dependencies. They are compiled
and bundled into the Matplotlib manylinux wheel, which is why the image installs no system font
package and why `--only-binary=:all:` matters — a locally built Matplotlib would link a different
FreeType and render different glyphs.

> **`requirements.txt` requires Python >= 3.12.** numpy 2.5.1 publishes no cp311 wheels.

### Changing the contract

**Python, Matplotlib, NumPy, Pillow, FreeType, the font stack and the base image are
visual-contract changes. They must never be auto-merged.**

`renovate.json5` labels `poster-renderer/**` updates `visual-contract` / `needs-visual-review` and
excludes them from auto-merge at every update type, including patch (see `docs/supply-chain.md`).
A patch bump that moves a tick label by one pixel silently invalidates the guarantee this whole
container exists to provide.

The review procedure:

1. Take the update on a branch.
2. Run the suite: `poster-renderer/.venv/bin/python -m pytest poster-renderer/tests`.
3. If `test_reference_image.py` fails, **look at the two images**. Render the new one with
   `--update-reference`, open both, and decide whether the difference is acceptable.
4. If it is, and only then, commit the regenerated reference *with* the dependency bump in the
   same commit, so the pixel change and its cause are inseparable in the history.
5. If the *contract itself* is meant to change — a new colour, a new layout — that is not an
   edit to `aat-poster-v1`. It is a new preset version, so posters already stored keep rendering
   the way they always have.

Regenerating a reference image to make a test pass, without looking at it, defeats every other
safeguard in this directory.

---

## 3. The service

### `POST /render`

Body: the poster plot spec defined by `packages/plot-spec/src/spec.ts`. Numeric series arrive as
base64 of little-endian float64 (`wire.ts`), because JSON has no NaN — and `NaN` in a `values`
array is the documented "gap" marker, drawn as a break in the line.

Response: `image/png`, with `X-Poster-Renderer-Version` and `X-Poster-Preset-Version`.

Validation is a from-scratch reimplementation of the Zod schema, in
[`src/poster_renderer/validation.py`](src/poster_renderer/validation.py), with every limit in
[`src/poster_renderer/limits.py`](src/poster_renderer/limits.py). The Worker has already validated
the request; the container validates it again because a container must never treat its caller as
trusted. Enforced: 8 MiB payload cap (checked against `Content-Length` before the body is read),
200,000 points per array, equal `time`/`values` lengths, finite ordered axis bounds, finite `time`
samples, no `±Infinity` anywhere, title <= 120 characters with no control characters, the series /
`posterKind` / preset enums, `dpi` in 72..600, figure dimensions in 2..20 inches, and **no unknown
keys anywhere**.

Two mirrors of one contract can drift, so `test_validation.py` asserts each constant by value
against `spec.ts`. It also closes two gaps where Python is laxer than JavaScript: `json.loads`
accepts the literals `NaN`/`Infinity` (rejected here), and Python's `\d` matches Unicode digits
(the run-code pattern is compiled with `re.ASCII`).

### `GET /health`

Readiness plus build identity: renderer version, app version (the watermark's), preset version,
and whether the render worker is warm. Used by the Docker `HEALTHCHECK`.

### Concurrency and backpressure

One render at a time. The waiting room is bounded (`POSTER_MAX_QUEUED`, default **0**), and a
request that finds it full is rejected immediately with **429 `POSTER_BUSY`** rather than queued.
An unbounded queue would convert a burst into a slow, memory-hungry meltdown instead of a fast,
retryable "no", and the API's poster endpoint is idempotent by design
(`docs/web-architecture.md`), so retrying is always safe.

Renders run in a persistent `spawn`ed subprocess. That is what makes the per-request deadline
truthful: a Matplotlib render is a long call into C and cannot be interrupted in-process, so when
the deadline expires the process is killed and its memory really is released. The same isolation
means a segfault in Agg or FreeType costs one request, not the service; the next request gets a
fresh worker. The worker is persistent, so the Matplotlib import is paid once at startup, not per
request.

### Error codes

Only the Worker talks to this container, so these codes are an internal contract; the Worker maps
them onto the localised taxonomy in `packages/shared/src/errors.ts`.

| Code | HTTP | Meaning | Shared taxonomy |
| --- | --- | --- | --- |
| `POSTER_BUSY` | 429 | Render slot and waiting room full | `POSTER_BUSY` (forwarded) |
| `POSTER_RENDER_FAILED` | 500 | Rendering raised | `POSTER_RENDER_FAILED` (forwarded) |
| `POSTER_RENDER_TIMEOUT` | 504 | Deadline exceeded, worker killed | `POSTER_RENDER_FAILED` |
| `POSTER_SPEC_INVALID` | 400 | Body is not a valid spec | `INTERNAL` — the Worker validated first, so this is a Worker bug |
| `POSTER_PAYLOAD_TOO_LARGE` | 413 | Body exceeds the transport cap | `EXPORT_TOO_LARGE` |
| `POSTER_UNSUPPORTED_MEDIA_TYPE` | 415 | Not `application/json` | `INTERNAL` |
| `POSTER_LENGTH_REQUIRED` | 411 | Chunked or missing `Content-Length` | `INTERNAL` |
| `POSTER_METHOD_NOT_ALLOWED` | 405 | Wrong method | `INTERNAL` |
| `POSTER_NOT_FOUND` | 404 | Unknown path | `INTERNAL` |

Error bodies are `{"code", "message", "field?"}` and **never quote client input** — nothing
client-controlled is reflected into a response, a header, or a log line.

### What the renderer cannot do

* No client-supplied code, ever. The spec is data; there is no field that becomes a callable.
* No client-supplied rcParams. Matplotlib's configuration is set once at import from
  `preset.FROZEN_RC_PARAMS` and never again.
* No client-supplied paths. PNG bytes are written to an in-memory buffer; the renderer never
  constructs a filesystem path and never spawns a shell. A run legitimately named
  `../../etc/passwd` renders as text and does nothing else — `test_hostile_titles_are_inert`.
* No interactive backend, and above all never WebAgg (which would open a socket). `MPLBACKEND=Agg`
  is forced in the package's `__init__` before Matplotlib is imported, and again in the image.
* No outbound network. Nothing is fetched at runtime. CI runs the image with `--network none`.

### Configuration

All from the environment, never from a request. Invalid values fail at startup rather than
producing surprising behaviour later.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTER_HOST` | `0.0.0.0` | Bind address |
| `POSTER_PORT` | `8080` | Bind port |
| `POSTER_RENDER_TIMEOUT_SECONDS` | `30` | Per-render deadline |
| `POSTER_STARTUP_TIMEOUT_SECONDS` | `60` | Worker readiness deadline |
| `POSTER_MAX_QUEUED` | `0` | Extra requests allowed to wait for the render slot |
| `POSTER_SOCKET_TIMEOUT_SECONDS` | `30` | Per-connection read/write timeout |
| `POSTER_MAX_CONCURRENT_REQUESTS` | `8` | Requests concurrently parsing bodies |

The payload cap is deliberately not configurable: it is one half of a contract with
`packages/plot-spec`.

### Why the standard library

Two endpoints, one content type, one client. A web framework would add a dependency tree to a
container whose entire value is that its dependency set is pinned, auditable, and never changes
without a visual-regression review. What a framework would buy — routing, body parsing,
validation — is three lines, one line, and the thing this service most needs to do by hand.

---

## 4. Development

A pinned virtualenv lives at `poster-renderer/.venv`.

```bash
# Run the suite (also how CI runs it, from the repository root)
poster-renderer/.venv/bin/python -m pytest poster-renderer/tests

# Serve locally
POSTER_PORT=8080 PYTHONPATH=poster-renderer/src poster-renderer/.venv/bin/python -m poster_renderer

# Build and test the image exactly as CI does
docker build -t aat-poster-renderer:dev poster-renderer
docker run --rm --network none aat-poster-renderer:dev python -m pytest /app/tests -q
```

On macOS or Windows, use the virtualenv. `requirements.txt` pins Linux wheels only, on purpose: it
is the container's lock file, not a cross-platform one, and it lists no sdists so an unsupported
platform fails loudly instead of building a subtly different binary.

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
Enable it when the reference was regenerated inside the image you are testing in — then it becomes
the strictest visual-regression gate available.

---

## 5. Related documents

* `packages/plot-spec/` — the spec schema and the TypeScript mirror of the preset
* `docs/supply-chain.md` — why these dependencies never auto-merge
* `docs/web-architecture.md` — where the renderer sits, and poster idempotency
* `docs/numerical-compatibility.md` — the bit-equality guarantee for the numbers being drawn
* `/home/user/AAT/gui/plot_controller.py`, `/home/user/AAT/gui/styles.py`,
  `/home/user/AAT/tests/gui/test_export_graph_invariance.py` — the originals
