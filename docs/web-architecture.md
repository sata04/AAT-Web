# Web architecture

## The governing principle

**Local AAT is the product. The cloud is an optional authenticated research
workspace.**

A researcher who is not logged in — or who has no network at all after the first
visit — must still be able to do essentially the complete scientific workflow:
load a CSV, analyse it, look at the graph, select a range, read the statistics,
compare datasets, and export Excel. Everything the cloud adds is *history and
collaboration*, not capability.

This is not a stylistic preference. It determines where every piece of code
lives, and it is the reason Cloudflare must never become the numerical analysis
engine: an analysis that depends on a Worker being reachable is an analysis that
stops being reproducible the day the account lapses.

## Where work happens

```
                         Browser (authoritative)
  ┌──────────────────────────────────────────────────────────────┐
  │  main thread            │  dedicated Web Worker              │
  │  ─────────────────────  │  ────────────────────────────────  │
  │  React UI               │  decode (UTF-8 → Shift_JIS)        │
  │  uPlot interaction      │  CSV parse (Papa Parse)            │
  │  range selection        │  column detection                  │
  │  status / progress      │  sync + gravity conversion         │
  │                         │  filtering                         │
  │  Excel / CSV / PNG      │  sliding-window statistics         │
  │  IndexedDB cache        │  G-quality sweep                   │
  └──────────────────────────────────────────────────────────────┘
                                    │
                   optional, only when authenticated
                                    ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Cloudflare Worker  (Hono, /api/v1/*)                         │
  │  auth · authorization · quotas · audit · metadata             │
  ├───────────────────────────┬──────────────────────────────────┤
  │  D1 (structured index)    │  R2 (private bulk objects)       │
  │  runs, revisions, metrics │  snapshots, posters, sources     │
  └───────────────────────────┴──────────────────────────────────┘
                                    │
                        formal poster request only
                                    ▼
  ┌──────────────────────────────────────────────────────────────┐
  │  Cloudflare Container: Python + Matplotlib Agg               │
  │  receives analysed series + a validated plot spec → PNG      │
  └──────────────────────────────────────────────────────────────┘
```

The container does **no analysis**. It receives numbers that were already
computed in the browser and draws them. That is the whole of its job, and
keeping it that narrow is what makes it cheap to run and safe to expose.

## Packages

| package | role | depends on |
| --- | --- | --- |
| `packages/analysis-core` | The numerical engine. Framework-free, no DOM, no React. Decode, parse, column detection, sync, gravity conversion, filtering, statistics, G-quality. | papaparse |
| `packages/shared` | Domain vocabulary shared by browser and Worker: error taxonomy, analysis config + hashing, run-code parsing, snapshot format, capabilities. | zod |
| `packages/plot-spec` | The only thing the browser may send the poster renderer: a strictly validated declarative plot specification, plus the frozen preset definitions. | zod |
| `apps/web` | The React application (`src/`) and the Cloudflare Worker (`worker/`). | the three above |
| `poster-renderer` | The canonical Matplotlib renderer, pinned and containerised. | (Python) |

Analysis code never lives inside a React component. The boundary is enforced by
the package split: `analysis-core` cannot import React because it does not
depend on it.

## Full resolution vs display resolution

This distinction is load-bearing and is kept explicit in the type names.

Interactive rendering downsamples — a 20-second run at 1 kHz is 20,000 points
against maybe 1,200 device pixels, and drawing all of them is wasted work.
Min/max-per-pixel decimation preserves the visual envelope, including spikes,
which naive stride sampling does not.

Downsampled data is used for **exactly one thing: drawing pixels.** It is never
used for the minimum-standard-deviation search, G-quality, range statistics,
Excel, cloud snapshots, or poster figures. Every one of those reads the
full-resolution `Float64Array`.

## Why a Web Worker

Analysis on a realistic file takes long enough that doing it on the main thread
would freeze the UI mid-drag. The worker owns the heavy path and reports
progress; the main thread stays responsive.

Two consequences worth stating because they are easy to get wrong:

- **Papa Parse's own `worker: true` option is not used.** The parse already
  runs inside AAT's dedicated worker; enabling Papa's worker would spawn a
  nested one, which is unsupported in this arrangement and buys nothing.
- **Buffers transfer, they do not copy.** Analysis results move back to the
  main thread as transferable `ArrayBuffer`s. Copying tens of megabytes per
  result is exactly the kind of avoidable allocation that kills a tab.

## Local persistence

The desktop app cached to pickle and HDF5 files next to the CSV. Neither
translates to a browser, and neither should be resurrected — pickle in
particular is an executable format, and deserialising one is a code-execution
primitive.

AAT Web uses **IndexedDB** as the baseline. OPFS is a progressive enhancement
only, never a requirement.

Cache identity preserves the spirit of the desktop invalidation rules, which
keyed on content rather than on filesystem metadata:

```
cacheKey = SHA-256(source bytes)
         + hash of the analysis-relevant configuration
         + analysis engine version
         + cache format version
```

Filename and modification time are deliberately *not* part of the key: a
renamed file is the same data, and a touched file is not different data. A
version mismatch or a corrupt entry fails safe by recomputing.

## Cloud sync is asynchronous and never blocks

When the user is authenticated, a completed analysis triggers cloud work. The
local analysis is already finished and usable at that point; the UI shows three
independent statuses rather than one blocking spinner:

```
Analysis        Ready
Cloud sync      Saving / Saved / Failed
Poster figure   Generating / Ready / Failed
```

If cloud sync or poster generation fails, **the local analysis still succeeded.**
The failure is surfaced, the local results stay, and retry is available and
idempotent.

## Automatic formal poster: exactly one per revision

An authenticated analysis produces exactly one automatic formal poster figure
per `(analysisRevisionId, autoPosterPresetVersion)` pair. Not one per page load,
not one per gallery render, not one per zoom.

Idempotency is enforced in the database — a uniqueness constraint on that pair —
rather than by a client-side check, because a client-side check loses to a
double-submit, a reload mid-request, or two devices.

V1 deliberately does **not** use Cloudflare Queues or Workflows for this. The
browser calls an idempotent endpoint after the revision and snapshot are
persisted; the endpoint talks to the container and stores the PNG. An
interrupted request is safe to retry. Adding a queue would add moving parts to
a workload that is one render per analysis.

## API surface

- `/api/v1/*` — the versioned application API, so a future CLI or Python client
  can be added without breaking the browser.
- Better Auth owns its own route prefix.
- Everything else is static assets, served asset-first; only the paths that need
  the Worker are routed through it.

There is no SSR. AAT is a client-side analysis application; server rendering
would add a runtime dependency to the one thing that is supposed to work
offline.

## Related documents

- `docs/numerical-compatibility.md` — the Python oracle and the bit-equality guarantee
- `docs/cloud-data-model.md` — D1 schema, R2 layout, revision semantics
- `docs/auth-security.md` — passkey-first authentication, invitations, capabilities
- `docs/poster-renderer.md` — the frozen visual contract
- `docs/cost-controls.md` — quotas, container lifecycle, spend guards
- `docs/supply-chain.md` — dependency policy
- `docs/deployment.md` — the verify/deploy trust boundary
- `docs/migration-from-desktop.md` — what happens to existing config and output
