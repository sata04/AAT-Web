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

The design response is to make the expensive path structurally hard to enter: one poster per
analysis, one container instance, a short idle teardown, a per-user rate limit, a per-user storage
ceiling, and an administrative kill switch that does not require a deploy.

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
| Containers | 25 GiB-hours memory; 375 vCPU-minutes CPU; 200 GB-hours disk | $0.0000025/GiB-s; $0.000020/vCPU-s; $0.00000007/GB-s | [Containers pricing](https://developers.cloudflare.com/containers/pricing/) |
| Container egress (NA/EU) | 1 TB/month | $0.025/GB | [Containers pricing](https://developers.cloudflare.com/containers/pricing/) |

## Where this application could actually spend money

| Billable surface | Reached by | Guard |
| --- | --- | --- |
| Static asset requests | every page load | not billed at all |
| Worker invocations | `/api/*` only | asset-first routing keeps the SPA off this path |
| Worker CPU | request handling | `limits.cpu_ms`; no analysis runs here |
| D1 rows | metadata reads and writes | no time series; keyset pagination; bounded page sizes |
| R2 storage | snapshots, posters, source backups | per-user quota with reservations; per-object caps |
| R2 operations | one per object read or written | one object per revision, not one per sample |
| Durable Object duration | one render | held only for the render, torn down after 60 s idle |
| **Container instance-time** | poster renders only | rate limit, `max_instances: 1`, sleep-after, circuit breaker |

The last row is the one that matters. Everything else in this application is metadata-shaped and
sits comfortably inside the included allowances at the scale a research group operates at; the
container is the only component that bills by the second for something a client can ask for.

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

## The container is the expensive half

The renderer runs on the `lite` instance type: **1/16 vCPU, 256 MiB memory, 2 GB disk**.

Container billing starts and stops with the instance, not with the deployment:

> Charges start when a request is sent to the container or when it is manually started. Charges
> stop after the container instance goes to sleep, which can happen automatically after a timeout.
> — [Containers pricing](https://developers.cloudflare.com/containers/pricing/)

Memory and disk are billed on provisioned resources, CPU on actual usage. For a `lite` instance
that means 0.25 GiB-seconds of memory and 2 GB-seconds of disk for every second it is awake,
regardless of whether it is drawing anything.

The three included allowances turn out to be calibrated to the same number:

| Allowance | Lite instance consumes | Instance-hours covered |
| --- | --- | --- |
| 25 GiB-hours memory | 0.25 GiB provisioned | 100 |
| 200 GB-hours disk | 2 GB provisioned | 100 |
| 375 vCPU-minutes CPU | ≤ 1/16 vCPU actual | 100 at full tilt; more in practice |

So the Workers Paid plan includes roughly **100 hours of lite container uptime per month**, and
uptime — not renders — is the unit that gets billed. That is what makes the idle teardown the
single most important cost control in the project.

### The sleep-after lifecycle

`POSTER_RENDERER_SLEEP_AFTER_MS` is **60 seconds**, set in
`apps/web/worker/container/poster-renderer.ts` and enforced with a Durable Object alarm that is
rescheduled on every request. A burst of renders keeps the container alive; an idle one is
destroyed.

The arithmetic is the justification. A container left warm for a working day costs eight
instance-hours, which is 8% of the monthly allowance, to serve perhaps two posters. With a 60-second
teardown, one isolated render occupies about 70 seconds of instance time — a 1–3 second cold start,
the render itself, and the idle window — so the included allowance covers on the order of **five
thousand isolated renders a month**. Beyond the allowance, memory and disk together cost
approximately $0.00000077 per instance-second, or about five cents per thousand renders, plus the
CPU actually consumed.

Sixty seconds is short enough that the steady state is "not running" and long enough that a
researcher generating two or three posters in a row pays one cold start rather than three. Cold
starts are treated as normal: the Durable Object polls `/health` for up to 45 seconds and answers
`POSTER_BUSY` if the container does not come up, rather than reporting a failed render.

### `max_instances: 1`

```jsonc
"containers": [
  {
    "class_name": "PosterRendererContainer",
    "name": "aat-poster-renderer",
    "max_instances": 1,
    "instance_type": "lite",
    "rollout_step_percentage": 100
  }
]
```

`max_instances` is "the maximum number of concurrent container instances you want to run at any
given moment" ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)).
Setting it to 1 caps the blast radius of a render storm.

The reasoning in `wrangler.jsonc` is worth restating: AAT renders one poster per analysis, so a
second instance would only ever exist because something is looping — and paying for that loop is
the failure mode this project cannot absorb. The Worker returns `POSTER_BUSY` as backpressure
instead of queueing work behind a scaling container fleet. Autoscaling is the correct answer for a
product with revenue per render; it is the wrong answer here, where the marginal render has no
value and the marginal bug has unbounded cost.

The Durable Object stub is addressed by the fixed name `poster-renderer` for the same reason:
giving every request its own object id would create a fleet of Durable Objects each trying to
start a container.

### Bounded concurrency, at three levels

| Level | Mechanism | Value |
| --- | --- | --- |
| Application | `AAT_MAX_CONCURRENT_RENDERS`, checked by `assertRenderCapacity` before any claim | 1 |
| Platform | `max_instances` | 1 |
| Container | one render slot plus `POSTER_MAX_QUEUED` waiting room | 1 + 0 |

`assertRenderCapacity` counts `poster_figures` rows in `rendering` whose `startedAt` is more
recent than `AAT_RENDER_STALE_SECONDS` (300 s) and refuses when that count reaches the cap. The
staleness window matters: a row left behind by a Worker evicted mid-render would otherwise block
every future render forever. It is checked **before** the claim, never after — a check that ran
afterwards would count the row this request had just moved into `rendering` and refuse its own
work.

The container enforces the same limit independently, with a waiting room of zero by default, so a
second simultaneous render is refused immediately with 429 rather than queued. An unbounded queue
would convert a burst into a slow, memory-hungry meltdown instead of a fast, retryable "no".

### The per-user poster rate limit

```ts
posterRender: { limit: 20, windowSeconds: 60 }
```

Twenty renders per minute per user, in `worker/services/rate-limit.ts`, consumed by all three
poster endpoints — automatic, custom and retry — before any capacity check or container call. It
is the only rate limit in the table that exists for cost rather than for credential security; the
others (`inviteRedeem`, `passkeyRegister`, `passkeyAuthenticate`, `inviteCreate`) protect
authentication paths.

The counter is a fixed window in D1, incremented by a single
`INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`, so two concurrent requests cannot both read
"19 of 20" and both proceed. The attempt is counted whether or not it is admitted, so a client that
keeps hammering keeps its own window open.

A fixed window admits up to twice the limit across a window boundary. For a limit whose purpose is
to stop a loop rather than to meter a paid resource, that is an acceptable trade for one round trip
and no per-request state.

### The circuit breaker

`system_flags['poster.renderer.circuit_breaker']` is the emergency stop. When an administrator
opens it through `PUT /api/v1/admin/renderer`, `assertRenderCapacity` throws `POSTER_BUSY` with
`reason: 'renderer_disabled'` and **no container call is attempted at all**.

It lives in D1 rather than in configuration precisely so that pulling it does not require a
deploy. That is the lever for "the renderer is misbehaving" and for "spend needs to stop *now*",
and waiting for a CI run to finish is exactly the wrong shape for the second situation.

A corrupt flag row is treated as closed — renderer available — which matches the default and shows
up in the admin endpoint as a missing reason. Failing the other way would mean a malformed JSON
value could silently disable poster generation across the deployment with no obvious cause.

## Opening the Run Gallery never invokes the container

This is worth stating explicitly, because "the gallery renders posters" is the natural assumption
and it would be ruinous.

| Gallery action | What it touches |
| --- | --- |
| List runs (`GET /runs`) | D1 only — a keyset-paginated query plus one tag lookup |
| Open a run (`GET /runs/:id`) | D1 only — the run row and its revision list |
| Read headline metrics (`GET /revisions/:id`) | D1 only — `analysis_metrics`, denormalised for exactly this |
| List a revision's posters (`GET /revisions/:id/posters`) | D1 only — `poster_figures` rows |
| Display a poster (`GET /posters/:id/image`) | D1 for authorisation, then one R2 `get`, streamed |
| Download a snapshot | D1 for authorisation, then one R2 `get`, streamed |

Only three endpoints can start a container: `POST /revisions/:id/poster/auto`,
`POST /revisions/:id/posters` and `POST /posters/:id/retry`. Nothing reads its way into a render.

Two design decisions make this hold rather than merely being true today. `analysis_metrics` exists
so the gallery can show "best 0.1 s window: 1.2e-4 G" without fetching a multi-megabyte object,
which means browsing history does not even generate R2 traffic. And the automatic poster endpoint
is idempotent by database constraint, so even a client that calls it on every gallery render gets
the existing figure back with `created: false` and renders nothing.

## The Worker's own CPU ceiling

```jsonc
"limits": {
  "cpu_ms": 30000
}
```

Nothing in this Worker legitimately needs 30 seconds of CPU: the heavy numerical work happens in
the browser, and a poster render is wall-clock time spent waiting on the container rather than CPU
burned in the isolate. Declaring the limit explicitly pins it against a future change to the
platform default, and a runaway request is caught rather than billed indefinitely. Note that
30,000 ms is currently *equal* to the Workers Paid default; if the browser-side guarantee holds,
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

`GET /api/v1/admin/renderer` reports the circuit breaker's state alongside it, and the audit log
(`GET /api/v1/admin/audit`) records every `poster.render`, `snapshot.upload`, `source.upload` and
`quota.update` with actor, target and byte counts — which is what makes a spend spike attributable
after the fact rather than merely visible.

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
2. **Add per-product usage notifications** for the surfaces that can run away — Workers requests,
   Containers, R2 — through Notifications → Add → Billable Usage. A budget alert monitors total
   dollar spend; a usage notification monitors a single product metric, and the two answer
   different questions. Reaching a container-usage threshold is actionable ("open the circuit
   breaker") in a way that a dollar figure is not.
3. **Watch the Billable Usage dashboard** during the first weeks. Manage Account → Billing →
   Billable Usage shows daily usage-based cost by product with free-tier allowances marked. It
   reports overage charges only, so a deployment sitting inside the allowances shows nothing —
   which is itself the signal to look for.
4. **Remember what the alerts do not do.** They do not pause or cap usage. The only things that
   actually stop spend in this system are the circuit breaker, lowering a user's quota, and
   removing the container binding. Rehearse the first one.

## What is deliberately not built

- **No Cloudflare Queues and no Workflows.** V1 renders one poster per analysis through an
  idempotent endpoint called after the revision and snapshot are persisted. A queue would add
  moving parts, another billed product, and a way for work to outlive the request that asked for
  it — which is precisely how a container ends up running for something nobody is waiting for.
- **No container autoscaling.** See `max_instances: 1` above.
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
- `docs/poster-renderer.md` — the container's lifecycle and what it is for
- `docs/deployment.md` — how the bindings and secrets reach production
