# Versioning

AAT Web carries eight version strings. They are not a naming inconsistency to be tidied into one
number: they answer different questions, they move at different rates, and two of them decide what
a *published research figure* looks like and what it claims about itself. This document says what
each one means, when to move it, and what breaks if it is moved carelessly — or not moved at all.

The short version, if you read nothing else:

- **A figure says `AAT v11.1.0` while AAT Web is `1.0.0`, and that is correct.** The watermark is a
  statement about the *figure*, not about the program that drew it. §2 is the long answer.
- **`DESKTOP_BASELINE_VERSION` in `poster-renderer` is drawn into every poster.** Moving it changes
  pixels. It is checked mechanically; do not hand-edit one copy.
- **A preset version is not a changelog.** Mint `aat-poster-v2` to change the *style*; fix
  `aat-poster-v1` in place when it was simply wrong about the desktop application.
- **`RENDERER_VERSION` is the one that absorbs "same spec, different bytes."** That is its job.

---

## 1. The eight versions

| Version | Where | Answers | Moves when |
| --- | --- | --- | --- |
| Desktop baseline | `reference/python/REFERENCE_VERSION.txt` | Which AAT release is this a rewrite of? | The vendored reference tree is re-taken from a newer AAT |
| ↳ watermark copy | `poster_renderer/version.py::DESKTOP_BASELINE_VERSION` | Which AAT release does this figure reproduce? | With the baseline — **visual contract** |
| ↳ about-line copy | `apps/web/src/app/version.ts::DESKTOP_BASELINE_VERSION` | Same, for the UI | With the baseline |
| Reference commit | `reference/python/REFERENCE_COMMIT.txt` | Which AAT *commit* is `reference/python/core/**` a copy of? | The reference tree is re-vendored |
| Preset version | `POSTER_PRESET_VERSIONS` / `preset.PRESET_VERSION` | What does this figure *look* like? | A deliberate style change — as a **new** version, never an edit |
| Renderer version | `poster_renderer/version.py::RENDERER_VERSION` | Which code drew this figure? | Any build that can produce different bytes |
| Analysis engine | `apps/web/src/app/version.ts::ANALYSIS_ENGINE_VERSION` | Which engine computed these numbers? | `@aat/analysis-core` changes a number — invalidates every local cache |
| App shell | `apps/web/src/app/version.ts::APP_VERSION`, `worker/config.ts::APP_VERSION` | Which AAT Web build produced this? | A behavioural change worth recording in a snapshot or audit entry |

Two of these are written down more than once, and both duplications are audited by
`scripts/check-versions.mjs`. The desktop baseline has a vendored source of truth
(`REFERENCE_VERSION.txt`); the app shell has none, so the browser's copy is treated as
authoritative and the Worker's must match it. The Worker's is not decoration: `POST /revisions`
stores `body.appVersion ?? APP_VERSION`, so if the two drift, the version recorded against a
revision depends on whether the client happened to send one.

### Why the desktop baseline is vendored as data

Three files restate the desktop release, and one of them — the watermark — prints it into the
corner of every PNG that goes into a paper. A figure that says `AAT v11.1.0` is asserting that it
reproduces AAT 11.1.0's export path. If AAT ships 11.2.0 and only two of the three copies are
updated, that assertion silently becomes false, and no test notices, because each copy is a
perfectly plausible string on its own.

So the version lives in `reference/python/REFERENCE_VERSION.txt`, beside the commit SHA the
reference tree was already pinned to, and `scripts/check-versions.mjs` — run by `pnpm test` via
`scripts/check-versions.test.mjs` — fails if any copy disagrees. Updating the baseline is: edit
one file, run the tests, be told by name which others are stale.

It is deliberately *not* generated at build time. The renderer is a container that must not read a
sibling repository; and a value that changes the pixels of every future figure should be a diff a
human approved, not a number that materialises during a build. The checker's job is only to make a
*partial* update impossible.

---

## 2. Why the figure's version is not AAT Web's version

A poster rendered by AAT Web 1.0.0 carries the watermark `AAT v11.1.0`. That looks like a bug and
is asked about roughly on first contact, so it is worth stating plainly what each number claims.

**`DESKTOP_BASELINE_VERSION` is a conformance claim about the figure, not a build identity.** It
says: *these are AAT 11.1.0's numbers, AAT 11.1.0's framing, AAT 11.1.0's style.* It is a
specification version. Two implementations that satisfy that specification stamp the same string —
which is exactly what makes a figure exported from the desktop and one rendered here
interchangeable.

The claim is verified rather than asserted. `tests/golden/**` holds `@aat/analysis-core`'s output
to the vendored Python oracle bit-for-bit (`docs/numerical-compatibility.md`); the preset content
hash and `test_reference_image.py` hold the pixels. If either ever stopped being true, CI would
fail before a figure could carry the claim.

**`APP_VERSION` in `apps/web` is the build identity** — which AAT Web produced this. It is
recorded against the analysis revision, where it can be precise, and it never reaches the
container at all.

### Why not put AAT Web's version in the watermark

Three reasons, in increasing order of importance.

1. **It is an `aat-poster-v2`.** The watermark text is drawn into the image, so changing it changes
   pixels — by this document's own §3, that is a new preset version, not an edit.

2. **Nobody reading a poster benefits from two version numbers.** The watermark is eight-point grey
   text in a corner. It has room for one fact, and the useful fact is which figure standard the
   reader is looking at.

3. **It would break the thing the renderer exists for.** A researcher who exported figures with the
   desktop before the migration and renders them here afterwards would end up with two different
   stamps on one poster, for figures whose numbers and pixels are verifiably identical. The reader
   would infer that something changed between them. Nothing did — that is the whole point of the
   bit-exact port and the frozen preset, and a version stamp that implied otherwise would be
   *worse* misinformation than the current state, not better.

### Where the build identity actually lives

Nothing is lost by keeping it off the figure, because the artifact is already traceable:

| Question | Answer, and where it is |
| --- | --- |
| Was this drawn by AAT Web or by the desktop? | The PNG's `Software` chunk. Desktop exports carry Matplotlib's own autogenerated string; ours reads `AAT poster-renderer aat-poster-renderer/1.1.0 (aat-poster-v1)` |
| Which renderer build drew it? | Same chunk, and `PosterFigureRecord.rendererVersion` |
| Which analysis, and which AAT Web build? | `sha256(png)` → `PosterFigureRecord.objectSha256` → `analysisRevisionId` → the snapshot's `appVersion` / `analysisEngineVersion` |
| What was it asked to draw? | `PosterFigureRecord.specHash` |

That chain is why the poster spec must **not** grow an `appVersion` field, tempting as it looks:
the field would land in the PNG bytes, and a re-render after an unrelated web deploy would produce
a different file for the same spec — quietly costing the idempotent poster endpoint its no-op
retry and `objectSha256` its meaning. The join key is the PNG's hash; the version belongs on the
row, not in the image.

### The name was the actual defect

Until this was written down, the constant was called `APP_VERSION`, `GET /health` reported it as
`appVersion`, and the startup log said `app=11.1.0`. Every one of those reads as *this program's
version*, so the natural conclusion was that AAT Web 1.0.0 was claiming to be 11.1.0. The values
were right and the names were wrong; the names now say what the value means.

---

## 3. Preset versions: when to mint `v2`, and when not to

`aat-poster-v1` is not "the first style we happened to ship". It is *defined* as the desktop
application's export figure, transcribed constant by constant from `gui/plot_controller.py`. That
definition is what decides how a change to it should be handled, and the two cases are genuinely
different:

**Mint a new preset version when the style changes.** A different colour, a different line width,
a different layout, a different title format — anything where the old figure was right and someone
now wants a different one. Stored posters record the preset they were rendered with, so `v1`
figures keep meaning what they meant, and `v2` becomes selectable alongside them. `presets.ts`'s
module doc is the authority here, and it is not negotiable: this is the entire reason the presets
are versioned rather than edited.

**Fix `v1` in place when `v1` was wrong about the desktop.** If the transcription is inaccurate,
`v1` is not a valid alternative style — it is a defect wearing the name of the thing it fails to
be. Minting a `v2` for it makes the situation permanently worse in two ways: the name that means
"the desktop figure" goes on meaning "not quite the desktop figure", and the incorrect rendering
becomes a legitimate, selectable, forever-supported option in the poster dialog's preset menu.

The distinction has been used exactly once, and it is worth reading as a worked example.

### Worked example: the missing G range

The desktop's `plot_gravity_level` calls `set_ylim(config["ylim_min"], config["ylim_max"])`
unconditionally, on the screen axes and on the export axes alike. There is no branch anywhere in
the desktop application where a gravity-level figure's y-axis is autoscaled.

`aat-poster-v1` shipped without a y-range. The spec's `yMin`/`yMax` were optional, the builder
omitted them when the caller did not ask, and the renderer read "absent" as "let Matplotlib decide"
— so the default poster was framed to its own data. It rendered beautifully, which is why it
survived review: the figure is only wrong when you put it next to another one. A clean 5 mG drop
and a spoiled 400 mG drop came out as identical-looking plateaus differing only in their tick
labels, defeating the comparison a reader of a poster is most likely to make by eye.

That is a transcription defect, not a style. It was fixed in `v1`:

- `presets.ts` and `preset.py` gained `yMin`/`yMax` = `-1 .. 1` G, from `config.default.json`.
- The builder resolves an omitted bound to the preset's, so a stored spec always states its frame.
- The renderer falls back to the preset's when a spec omits them, so specs written before the
  builder resolved them render correctly too.
- The pinned preset content hash in `presets.test.ts` moved, with the reasoning recorded beside it.

No stored figure moved: rendered PNGs are stored in R2, not re-rendered on read. And no *bounded*
figure's pixels moved either — `test_reference_image.py` under `POSTER_STRICT_REFERENCE_BYTES=1`
still matches the reference committed before the fix.

The thing that did move is `RENDERER_VERSION`, which is exactly what it is for.

---

## 4. `RENDERER_VERSION` is the byte-level version

`PosterFigureRecord` stores `presetVersion` *and* `rendererVersion` for every figure. The two are
not redundant:

- `presetVersion` answers "what was this figure supposed to look like?"
- `rendererVersion` answers "what code actually drew it?"

Any build that can produce different bytes from the same spec gets a new `RENDERER_VERSION` —
including a Matplotlib, NumPy, Pillow or base-image bump, which is the ordinary case (see
`poster-renderer/README.md`, "Why the versions are pinned"). Bump the MINOR when the output can
differ, the PATCH when it provably cannot. Because it is not drawn into the figure, moving it
costs nothing except a changed `Software` text chunk in the PNG metadata — which is deliberate:
the version that must be free to move should not be one that moves pixels.

---

## 5. Checklist: adopting a new desktop release

1. Re-vendor `reference/python/core/**` from the new AAT commit.
2. Update `reference/python/REFERENCE_COMMIT.txt` and `reference/python/REFERENCE_VERSION.txt`.
3. Run `pnpm test`. `check-versions` names every stale copy; update them.
4. Run `python reference/python/generate_golden.py --check`. If the goldens moved, the desktop
   changed a number — that is a `docs/numerical-compatibility.md` question, not a versioning one.
5. Re-read the poster export path in the new release against `presets.ts` / `preset.py`. If the
   desktop changed its *style*, that is an `aat-poster-v2`, not an edit to `v1`.
6. The watermark now reads differently, so the reference PNG legitimately moved. Regenerate it
   with `--update-reference`, **look at both images**, and commit the regenerated reference in the
   same commit as the version bump, per `poster-renderer/README.md`.
7. Bump `RENDERER_VERSION`: step 6 means the same spec now produces different bytes.
