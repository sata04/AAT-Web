# Cost controls

## Workers Paid is not a spending cap

The Workers Paid plan is a $5/month subscription with included allowances and **usage-based
overage beyond them**. Cloudflare does not offer a hard spending cap or maximum monthly spend
limit for Workers. Budget alerts exist, and this project recommends setting one, but they are
explicitly informational:

> Budget alerts are informational only. They do not pause or cap usage.
> — [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)

Everything in this document follows from that one fact. AAT Web is a small research tool with no
revenue and no operations team, so a runaway loop is not a performance problem to tune later — it
is an unbounded invoice arriving at somebody's personal card. **The guards therefore have to live
in the application, because the platform will not stop it.**

The design response used to be a stack of guards around the one component that could spend money
per request — the poster-rendering container. That component is gone: the poster is now drawn in
the browser by Pyodide, so no client action can start billable compute. What remains is the
quieter discipline this document describes: a per-user storage ceiling, per-object size caps,
asset-first routing, and one whole-cloud off switch.

## The rates quoted here, and when they were checked

Every figure below was verified against Cloudflare's official documentation on **2026-08-12**.
Prices and allowances change; **re-check them against the linked page before relying on any number
in this document.** A wrong number in a cost document is worse than no number.

| Product | Included on Workers Paid | Overage | Source |
| --- | --- | --- | --- |
| Workers | 10 million requests/month; 30 million CPU-ms/month | $0.30/million requests; $0.02/million CPU-ms | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Workers Static Assets | "Requests to static assets are free and unlimited" | — | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 | 25 billion rows read/month; 50 million rows written/month; 5 GB storage | $0.001/million rows read; $1.00/million rows written; $0.75/GB-month | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 Standard | 10 GB-month storage; 1 million Class A ops; 10 million Class B ops | $0.015/GB-month; $4.50/million Class A; $0.36/million Class B; **egress free** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Durable Objects | 1 million requests/month; 400,000 GB-s duration/month | $0.15/million requests; $12.50/million GB-s | [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |

(Durable Objects and Containers are listed for completeness; this deployment uses neither — see
below.)

## Where this application could actually spend money

| Billable surface | Reached by | Guard |
| --- | --- | --- |
| Static asset requests | every page load | not billed at all |
| Worker invocations | `/api/*` only | asset-first routing keeps the SPA off this path |
| Worker CPU | request handling | `limits.cpu_ms`; no analysis runs here |
| D1 rows | metadata reads and writes | no time series; keyset pagination; bounded page sizes |
| R2 storage | snapshots, posters, source backups | per-user quota with reservations; per-object caps |
| R2 operations | one per object read or written | one object per revision, not one per sample |

Every row is metadata-shaped and sits comfortably inside the included allowances at the scale a
research group operates at. There used to be a seventh row — container instance-time, billed by
the second for something a client could ask for — and the poster migration removed it rather than
guarding it harder.

## The SPA never invokes the Worker

`wrangler.jsonc` uses Workers Static Assets with asset-first routing:

```jsonc
"assets": {
  "directory": "./dist/client",
  "binding": "ASSETS",
  "html_handling": "auto-trailing-slash",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]
}
```

Every request is served from the static asset store unless it matches `run_worker_first`, so the
React application — the part that must keep working with no account and no network — costs nothing
per load. Only `/api/*` reaches the Worker, which covers both the versioned application API and
Better Auth's prefix.

This is a cost guard *and* an architectural one: a logged-out user doing a complete local analysis
generates exactly zero billable Worker invocations.

## Per-user storage quotas

| Var | Value | Meaning |
| --- | --- | --- |
| `AAT_DEFAULT_QUOTA_BYTES` | 1,073,741,824 (1 GiB) | Ceiling applied to each user on first use |
| `AAT_MAX_SNAPSHOT_BYTES` | 16,777,216 (16 MiB) | Largest accepted analysis snapshot, gzipped |
| `AAT_MAX_SOURCE_BYTES` | 33,554,432 (32 MiB) | Largest accepted original CSV backup |
| `AAT_MAX_POSTER_BYTES` | 8,388,608 (8 MiB) | Largest accepted poster PNG |
| `AAT_RESERVATION_TTL_SECONDS` | 900 (15 min) | How long a pending reservation holds quota |

The per-object caps bound Worker memory as well as storage: `readBoundedBody` accumulates the body
in the isolate so the exact byte count and SHA-256 are known before anything is committed, and
`maxBytes` is what makes that bounded rather than unbounded buffering. `Content-Length` is
consulted only as a courtesy early rejection — it is client-supplied, and a client that wants to
overrun a quota will simply lie. The stream is cancelled the moment the real count crosses the
limit, so an oversized upload costs the transfer up to the limit and no more.

The reservation mechanism (`worker/services/quota.ts`, described in full in
`docs/cloud-data-model.md`) is what makes the ceiling hold under concurrency: the limit test lives
inside the reserving UPDATE's WHERE clause, so two simultaneous uploads that would each fit
individually cannot both succeed past the limit. A quota that can be raced is not a quota.

An administrator can raise or lower any user's ceiling through
`PUT /api/v1/admin/quotas/:userId`, which refuses to set a limit below what is already stored —
lowering it below current usage would create an account that can neither upload nor be brought
back into compliance without deleting data.

## R2 is the cheap half, and deliberately so

At the sizes involved, storage is close to free. A 20-second run at 1 kHz produces a snapshot of
roughly 2 MB of base64 before gzip; the free tier alone is 10 GB-month, which is on the order of
five thousand such snapshots, and beyond it storage is $0.015/GB-month.

Two properties of R2 do most of the work:

- **Egress is free.** Downloading a snapshot to reopen an analysis, or a poster to put in a paper,
  costs one Class B operation and no data transfer. The equivalent design on an object store that
  charges egress would have made "let researchers re-download their own measurements" a line item.
- **One object per revision, not one row per sample.** The comparison is worked through in
  `docs/cloud-data-model.md`: storing series in D1 would cost roughly $0.20 per revision in row
  writes past the allowance against roughly $0.0000045 in R2 operations.

The one thing to watch is object *count* rather than object size, since Class A operations are the
expensive class at $4.50/million. AAT writes at most three objects per revision (snapshot, poster,
and optionally the source CSV), so a group producing a hundred runs a month writes a few hundred
Class A operations against a million-operation free tier.

## Original-source upload is opt-in, and that is a cost decision as well as a privacy one

`PUT /api/v1/runs/:runId/source` requires the header `x-aat-source-backup: requested-by-user` and
answers `FORBIDDEN` without it. The privacy argument is in `docs/cloud-data-model.md`: being
signed in is not consent to upload raw measurement data.

The cost argument is separate and points the same way. A source CSV is capped at 32 MiB — twice
the snapshot cap — and a client that uploaded the source alongside every analysis would roughly
triple per-revision storage while adding nothing the snapshot does not already contain (the
snapshot carries every full-resolution series *and* the source's SHA-256). Making it a per-request
header rather than a setting means there is no configuration state that can be flipped once and
silently apply to every future upload.

## The poster migration removed the expensive half

Everything this section used to defend against — instance-time billing, render storms, the
waiting room, the concurrency caps, the per-user render rate limit, and the circuit breaker an
administrator pulled when spend had to stop *now* — existed for one reason: the poster renderer
was a Cloudflare Container, and a container is the only component in this system that billed by
the second for work a client could request.

The poster is now drawn **in the browser** by Pyodide + Matplotlib in a Web Worker
(`docs/poster-renderer.md`). Rendering costs the user their own CPU and memory and the deployment
nothing at all. What the cloud side still does with a poster is *store* it, and storing is
bounded by the same two numbers that bound every other upload: `AAT_MAX_POSTER_BYTES` (8 MiB) per
figure and the owner's storage quota. A loop can waste the quota of the account that runs it; it
cannot produce per-second billing, because there is nothing left that bills per second.

That is also why the runtime circuit breaker is gone and nothing replaced it: there is no
per-request spend left to interrupt. The remaining whole-cloud stop is `AAT_CLOUD_ENABLED='false'`
(`docs/deployment.md`), which makes every `/api/*` path answer 404 and turns the deploy into a
static Pages site — a redeploy-shaped kill switch rather than a flag a request can hit, and
accordingly the right size for what it now protects.

## Opening the Run Gallery never renders anything

This is worth stating explicitly, because "the gallery renders posters" is the natural assumption
and it would be wrong in a subtle way: it cannot spend, but the record-keeping still matters.

| Gallery action | What it touches |
| --- | --- |
| List runs (`GET /runs`) | D1 only — a keyset-paginated query plus one tag lookup |
| Open a run (`GET /runs/:id`) | D1 only — the run row and its revision list |
| Read headline metrics (`GET /revisions/:id`) | D1 only — `analysis_metrics`, denormalised for exactly this |
| List a revision's posters (`GET /revisions/:id/posters`) | D1 only — `poster_figures` rows |
| Display a poster (`GET /posters/:id/image`) | D1 for authorisation, then one R2 `get`, streamed |
| Download a snapshot | D1 for authorisation, then one R2 `get`, streamed |

Only two endpoints accept a poster upload: `POST /revisions/:id/poster/auto` and
`POST /revisions/:id/posters`. Nothing reads its way into storing anything.

Two design decisions make this hold rather than merely being true today. `analysis_metrics` exists
so the gallery can show "best 0.1 s window: 1.2e-4 G" without fetching a multi-megabyte object,
which means browsing history does not even generate R2 traffic. And the automatic poster endpoint
is idempotent by database constraint, so even a client that calls it on every gallery view gets
the existing figure back with `created: false` and stores nothing twice.

## The Worker's own CPU ceiling

```jsonc
"limits": {
  "cpu_ms": 30000
}
```

Nothing in this Worker legitimately needs 30 seconds of CPU: the heavy numerical work happens in
the browser, and a poster upload is a bounded body read plus two small writes. Declaring the
limit explicitly pins it against a future change to the platform default, and a runaway request
is caught rather than billed indefinitely. Note that 30,000 ms is currently *equal* to the
Workers Paid default; with the render gone there is no wall-clock wait left to justify it, so
this value has considerable room to come down.

`observability.head_sampling_rate` is 1 — every invocation is sampled. At this volume that is the
right trade: complete logs on a deployment serving a research group cost little and are the only
way to see a loop starting.

## The admin usage view

`GET /api/v1/admin/storage` (capability `quota:manage`) is the operator's view of where storage has
gone:

| Section | Contents |
| --- | --- |
| `perUser` | Up to 200 rows, ordered by `bytesUsed` descending: user id, display name, role, `bytesUsed`, `bytesReserved`, `bytesLimit`, `objectCount` |
| `totals` | Live object count and summed bytes across all non-deleted `cloud_objects`, plus total runs and revisions |

Ordering by usage descending is deliberate: the question this endpoint answers is "who is
consuming the account", and that is always a question about the top of the list. `bytesReserved`
appearing beside `bytesUsed` makes a stuck reservation visible as a discrepancy rather than as an
unexplained shortfall in someone's available space.

It reports **metadata only**. An administrator can see that a researcher stores 400 MB across 60
objects; they cannot read any of it. See `docs/cloud-data-model.md` on why administrators are not
exempt from the ownership check.

The audit log (`GET /api/v1/admin/audit`) records every `poster.upload`, `snapshot.upload`,
`source.upload` and `quota.update` with actor, target and byte counts — which is what makes a
spend spike attributable after the fact rather than merely visible.

## Recommended Cloudflare account setup

The application-level guards bound what AAT Web can spend. These account-level settings are what
tell a human when something has gone wrong anyway. **Configure them before the first deploy**, not
after the first surprise.

1. **Set a budget alert.** Manage Account → Billing → Billable Usage → *Create budget alert*, or
   Notifications → Add → Budget Alert. It emails when account-wide usage-based spend crosses a
   dollar threshold. Set it low — for a deployment expected to sit inside the included allowances,
   a threshold of a few dollars above the $5 subscription is a meaningful signal rather than noise.
   Budget alerts are available to Pay-as-you-go accounts only; Enterprise contract accounts are not
   supported.
2. **Add per-product usage notifications** for the surfaces that can run away — Workers requests
   and R2 — through Notifications → Add → Billable Usage. A budget alert monitors total
   dollar spend; a usage notification monitors a single product metric, and the two answer
   different questions.
3. **Watch the Billable Usage dashboard** during the first weeks. Manage Account → Billing →
   Billable Usage shows daily usage-based cost by product with free-tier allowances marked. It
   reports overage charges only, so a deployment sitting inside the allowances shows nothing —
   which is itself the signal to look for.
4. **Remember what the alerts do not do.** They do not pause or cap usage. The only things that
   actually stop spend in this system are lowering a user's quota and redeploying with
   `AAT_CLOUD_ENABLED='false'`, which answers every `/api/*` with 404. Rehearse the second one.

## What is deliberately not built

- **No Cloudflare Queues and no Workflows.** V1 stores one poster per analysis through an
  idempotent endpoint called after the revision and snapshot are persisted. A queue would add
  moving parts, another billed product, and a way for work to outlive the request that asked for
  it.
- **No scheduled triggers.** There is no cron in this Worker; the stale-reservation sweeper runs
  opportunistically on the upload paths instead. A scheduled invocation that runs whether or not
  anyone is using the system is a standing charge for an idle deployment.
- **No presigned URLs or public bucket.** Every object read goes through the Worker. This costs
  one Worker invocation per download and buys the ownership check; at this volume the invocation
  is free.

## Outstanding

- **No usage screen exists.** `GET /api/v1/admin/storage` is implemented and tested; the admin
  console that would display it is not.
- **Nothing alerts on quota pressure automatically.** A user approaching their ceiling discovers
  it when an upload fails with `QUOTA_EXCEEDED`. The data to warn earlier is in `quota_usage`; the
  warning is not built.
- **The stale-reservation sweeper only runs when someone uploads.** A deployment that goes quiet
  with pending reservations outstanding leaves them held until the next upload. They are
  reservations rather than stored bytes, so nothing is being paid for — but a user's available
  space stays understated in the meantime.
- **`limits.cpu_ms` is set to the platform default** rather than to something the Worker actually
  needs, so it currently pins the ceiling rather than lowering it.

## Related documents

- `docs/web-architecture.md` — why the browser does the expensive work
- `docs/cloud-data-model.md` — quota accounting and the reservation protocol in full
- `docs/poster-renderer.md` — where the poster is drawn now, and what the upload endpoint checks
- `docs/deployment.md` — how the bindings and secrets reach production, and how `AAT_CLOUD_ENABLED` turns the cloud half off
