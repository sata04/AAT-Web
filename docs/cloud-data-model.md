# Cloud data model

The cloud half of AAT Web stores the *history* of an analysis, never the ability to perform
one. A researcher who is logged out still loads a CSV, analyses it, reads the statistics and
exports Excel; what an account adds is a durable, attributable record of what was analysed,
with which settings, and what came out — years after the laptop that did it has been replaced.

This document is the reference for that record: the entities, which store holds what, how a
read is authorised, and how storage is accounted for.

## Four entities, and why there are four

```
  user
   └── project            optional grouping. Owns runs; is not itself an experiment.
        └── run           ONE physical experiment — one drop of the capsule.
             └── analysisRevision    ONE immutable analysis of that run's bytes.
                  ├── analysisMetrics   headline numbers, denormalised for the gallery
                  ├── snapshot object   the full-resolution analytical record (R2)
                  └── posterFigure(s)   rendered PNGs (R2), one automatic + N custom
```

| Entity | Table | What it means | What it is not |
| --- | --- | --- | --- |
| Project | `projects` | A research grouping — a campaign, a paper, a student's thesis. | An experiment. It holds no measurements. |
| Run | `runs` | One physical drop of the capsule, identified by its run code. | A file. Re-uploading the same CSV does not make a second run. |
| Analysis revision | `analysis_revisions` | One analysis of one run's bytes with one configuration. | A version of the experiment. Dropping the capsule twice makes two *runs*. |
| Poster figure | `poster_figures` | One rendered formal figure of one revision. | The graph on screen — that is drawn locally and never stored. |

The distinction that carries the most weight is the last one in the Run row. `runs` and
`analysis_revisions` are separated precisely so that "revision 3" has exactly one meaning. If a
repeated experiment were recorded as a new revision of the same run, then "revision 3" would
mean *either* "the third time we analysed this data" *or* "the third time we ran this
experiment" depending on who was reading — and the second reading silently destroys history,
because it makes two different measurements look like two attempts at describing one.

So: same capsule drop, different analysis settings → a new revision. Second capsule drop →
a new run, with its own run code.

## D1 indexes, R2 stores, and no sample ever becomes a row

`apps/web/worker/db/schema.ts` states the rule at the top of the file and the schema keeps it:

> **No time series.** Not one table stores a sample per row. Full-resolution series live in R2
> as snapshot objects; D1 stores the metadata needed to find, authorise and describe them.

This is not a stylistic preference about where blobs belong. Take the `realistic_large`
fixture's shape — 20 seconds at 1 kHz, so 20,000 samples per channel. A snapshot carries ten
full-resolution series (adjusted time, gravity, raw acceleration and the filtered forms, for
both sensors), which is 200,000 float64 values for a single revision of a single short run.

| As D1 rows | As one R2 object |
| --- | --- |
| 200,000 rows written per revision | 1 Class A operation |
| 200,000 rows read to redraw one graph | 1 Class B operation |
| The Workers Paid allowance of 50 million rows written per month is exhausted by ~250 revisions | 2.1 MB of base64 before gzip, against a 10 GB-month free allowance |
| Beyond the allowance: $1.00 per million rows written, so ~$0.20 per revision | $4.50 per million Class A operations, so ~$0.0000045 per revision |

Rates checked against [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) on 2026-08-12; confirm current
figures there before quoting them anywhere that matters.

Four orders of magnitude is not an optimisation, it is a different design. And the cost is only
half the argument: a series stored as rows has to be reassembled in a defined order every time
it is read, which makes ordering a correctness property of a query rather than of a byte layout.
A `Float64Array` written to an object has no ordering question.

### What each D1 table is for

| Table | Role |
| --- | --- |
| `user`, `session`, `account`, `verification`, `passkey` | Better Auth's own tables. See `docs/auth-security.md`. |
| `registration_invites` | Invitation state machine; only the token's SHA-256 is stored. |
| `projects` | Optional grouping of runs. |
| `runs` | One physical experiment, plus its filename-derived identity. |
| `run_tags` | Free-form tags. A join table, not a JSON column, because the gallery filters by tag and filtering a JSON blob means a full scan. |
| `analysis_revisions` | The immutable analysis records. |
| `analysis_metrics` | Headline numbers denormalised out of the snapshot, one row per revision. |
| `poster_presets` | The frozen preset registry: key, version, spec hash, renderer version. |
| `poster_figures` | One row per rendered figure, with its lifecycle status. |
| `cloud_objects` | The index of everything in R2. |
| `quota_usage`, `quota_reservations` | Per-user storage accounting. |
| `audit_logs` | Append-only record of security-relevant actions. |
| `system_flags` | Operational switches — currently the renderer circuit breaker. |
| `rate_limits` | Fixed-window counters. |

Every identifier is a ULID (`worker/lib/ids.ts`). Sequential integers would leak how many users
exist and how many runs a colleague has uploaded, and would turn an IDOR probe into counting.
ULIDs also sort lexicographically by creation time, which is why keyset pagination in the run
listing can order on `runs.id` alone and why several indexes carry no separate ordering column.

## Run identity comes out of the filename

The drop-tower workflow names its files `YYMMDD_data.csv`, with a single lowercase suffix letter
when more than one run happens on the same calendar day. `parseRunFilename` in
`packages/shared/src/run-code.ts` is the only thing that reads that convention:

```
/^(?<date>\d{6})(?<suffix>[a-z]?)_data\.csv$/
```

| Filename | `runCode` | `experimentDate` | `suffix` | `matched` |
| --- | --- | --- | --- | --- |
| `260812_data.csv` | `260812` | `2026-08-12` | `''` | true |
| `260811a_data.csv` | `260811a` | `2026-08-11` | `'a'` | true |
| `260811b_data.csv` | `260811b` | `2026-08-11` | `'b'` | true |
| `260230_data.csv` | `null` | `null` | `null` | **false** — 30 February is not a date |
| `experiment_final_v2.csv` | `null` | `null` | `null` | false |

Two properties are load-bearing:

- **The suffix is part of the identity, not a decoration.** `260811a` and `260811b` are two
  experiments, so they are two `runs` rows, and the uniqueness constraint is on the full run
  code. Treating the suffix as metadata would make the second drop of the day collide with the
  first.
- **A non-matching filename does not throw.** `toIsoDateIfValid` rejects impossible calendar
  dates by round-tripping through `Date.UTC` and comparing the fields back, because
  `Date.UTC(2026, 1, 30)` silently normalises to 2 March. A `matched: false` result leaves the
  caller free to ask the user for the run code by hand — which `POST /api/v1/runs` supports
  through an explicit `runCode` field. Only if *both* the filename and the explicit field are
  absent does the request fail, with `INVALID_ANALYSIS_CONFIG` and
  `reason: 'run_code_required'`.

Runs with no parsed date still sort deterministically: `compareRunGalleryEntries` places them
after every dated entry, ordered by filename, so an unrecognised upload does not scatter through
the gallery.

Uniqueness is **per owner** (`runs_owner_run_code_unique` on `(owner_user_id, run_code)`). Two
researchers each having a run `260811a` is normal; a global constraint would make one of them
unable to record their own experiment.

## An analysis revision is immutable, and the database defines what "the same analysis" means

A revision is created and never updated. There is no PATCH and no PUT that replaces one — the
only writes are "create a revision" and "attach the snapshot it was created for".

What makes that enforceable rather than aspirational is a unique index over the analysis
identity:

```sql
CREATE UNIQUE INDEX `revisions_run_identity_unique`
  ON `analysis_revisions` (`run_id`,`source_sha256`,`config_hash`,`engine_version`);
```

Same bytes, same settings, same engine — one analysis, therefore one row. `POST
/runs/:runId/revisions` looks the identity up first and returns the existing revision with
`created: false` and HTTP 200 rather than minting a duplicate. A retried request over a flaky
network, a double-clicked button, and the same analysis run on two devices all converge on one
revision.

The revision *number* is derived rather than client-supplied: `COALESCE(MAX(revision_number), 0)
+ 1`, inserted under `revisions_run_revision_number_unique`. Two concurrent creates can compute
the same next number; the index rejects the loser, which retries (bounded at three attempts) and
recomputes. A lock would be heavier than the single statement the contention window is wide.

### What immutability buys

- **A published figure stays explicable.** `config_json` holds the full analysis configuration
  as canonical JSON, not only its hash, so a revision explains itself without a lookup into a
  settings table that may have moved on.
- **`engine_version` and `app_version` are recorded per revision.** A numerical change in
  `@aat/analysis-core` produces a *new* revision rather than silently altering an old one, which
  is what keeps `docs/numerical-compatibility.md`'s bit-equality guarantee attached to a specific
  result rather than to the project in general.
- **A snapshot cannot be swapped underneath a revision.** Re-uploading identical bytes (same
  SHA-256) is answered idempotently; uploading *different* bytes for a revision that already has
  a snapshot fails with `SNAPSHOT_INVALID` and
  `reason: 'revision_already_has_a_different_snapshot'`. The analytical record is append-only in
  practice, not only by convention.

## The snapshot is the analytical record

`packages/shared/src/snapshot.ts` defines the format. Version 1 is the only version
(`SNAPSHOT_FORMAT_VERSION = 1`), and the number is recorded on the revision row as
`snapshot_format_version` so a future format can be introduced without a migration that touches
stored objects.

A snapshot carries everything needed to redraw the graph, recompute range statistics over any
selection, rebuild the Excel export's sheets and build a custom poster — **without the original
CSV ever again**:

| Field | Contents |
| --- | --- |
| `sourceSha256`, `originalFilename` | Provenance of the bytes that were analysed. |
| `config`, `configHash` | The analysis configuration and its hash at analysis time. |
| `analysisEngineVersion`, `appVersion` | What produced it. |
| `detectedColumns` | Which time and acceleration columns were chosen. |
| `sync` | Per-sensor sync indices, which fallback fired, candidate counts. |
| `filter` | Per-sensor filtered index bounds and lengths. |
| `warnings` | Warning codes raised during analysis. |
| `series` | Ten full-resolution `Float64Array`s (see below). |
| `statistics` | Minimum-standard-deviation window statistics per sensor. |
| `gQuality` | The full multi-window sweep. |
| `provenance`, `analysisTimestamp` | Where it came from and when. |

The ten series are `innerAdjustedTime`, `dragAdjustedTime`, `innerGravity`, `dragGravity`,
`innerAcceleration`, `dragAcceleration`, `filteredTime`, `filteredAdjustedTime`,
`filteredInnerGravity` and `filteredDragGravity`. Each is present — possibly zero-length — even
for a sensor the run did not use, so downstream code branches on a series being *empty*, never
on a field being *absent*.

**Snapshots are never downsampled.** The module doc says so in capitals, and the reason is that
storage is a solved problem while silently-lossy history is not. A decimated snapshot would be a
picture of an analysis rather than a record of one, and the difference only becomes visible years
later when somebody needs the number rather than the shape.

### NaN survives, in two different ways

Plain JSON cannot represent NaN or ±Infinity, and both are legitimate values here: a missing
sample, a saturated sensor, a window with no valid data. The format uses two encodings, chosen
per shape:

- **Series** are base64 of a little-endian `Float64Array`. Exact for every IEEE-754 bit pattern
  — NaN, ±Infinity, −0 and any NaN payload round-trip bit for bit — and far more compact than a
  number array with tagged exceptions scattered through it.
- **Scalars** use the tagged strings `"NaN"`, `"Infinity"`, `"-Infinity"` and `"-0"`. The fourth
  tag is deliberate: `JSON.stringify(-0) === "0"`, so without it a window statistic that is
  exactly negative zero would silently become positive zero across a save/load round trip.

The same tagging is used for the scalar columns in `analysis_metrics`, which is why they are
`text` rather than `real`.

### A snapshot is validated before it is stored, not when it is read

`PUT /api/v1/revisions/:revisionId/snapshot` is a chain of refusals:

1. `declaredBytes` must not exceed `AAT_MAX_SNAPSHOT_BYTES` (16 MiB).
2. Quota is reserved for the declared size — see below.
3. The body is read with a hard cap set to the reservation, hashed while it is read, and
   compared against the `sha256` query parameter. A mismatch is `SNAPSHOT_INVALID`.
4. It is gunzipped if `format=json.gz`, then parsed through `decodeSnapshot`, which re-validates
   against the Zod schema. Malformed bytes are rejected here.
5. Its `sourceSha256` and `configHash` are compared against the revision's own. A snapshot that
   does not match the revision it is being filed under is rejected with
   `reason: 'does_not_match_revision'`.
6. Only then is it written to R2 — with `sha256` passed to `R2Bucket.put`, so R2 verifies the
   digest itself and rejects the write on mismatch.

The alternative to validating on upload is discovering the problem at the moment a researcher
reopens a two-year-old measurement, which is the worst possible time to find out.

## Original-source CSV backup is opt-in per request

`PUT /api/v1/runs/:runId/source` stores the raw CSV. It is off by default and cannot be reached
by accident: the request must carry the header

```
x-aat-source-backup: requested-by-user
```

and the absence of it is answered `FORBIDDEN` with `reason: 'source_backup_not_requested'`.
Being signed in is not consent to upload raw measurement data. A client that "helpfully" uploads
the source alongside every analysis is exactly the behaviour this header exists to make
impossible to write by accident — a capability check alone would not have stopped it, because
the capability (`raw:upload`) is one a Researcher legitimately holds.

The upload is capped at `AAT_MAX_SOURCE_BYTES` (32 MiB) and its filename is stored in
`cloud_objects.original_filename` as metadata. It is never a key component. Deleting a source
backup (`DELETE /runs/:runId/source`, capability `raw:delete`) removes the bytes and corrects the
owner's quota in the same request.

Both writes are resolved at `destroy`, so a colleague reaches neither: consent to a backup of
*your* CSV is not consent to somebody else filing one under your name, and a Researcher who could
delete a colleague's raw measurement could destroy the only remaining copy of an experiment.
**Downloading** one is a `read` and any member may do it — re-analysing a colleague's raw data is
the point of the shared workspace.

## R2 keys are built from server-generated identifiers, never accepted

```
snapshots/<ownerUserId>/<runId>/<revisionId>.<json|json.gz>
posters/<ownerUserId>/<runId>/<revisionId>/<posterId>.png
sources/<ownerUserId>/<runId>/<objectId>.csv
```

**`<ownerUserId>` is the owner of the run, never the user who made the request.** Since the shared
workspace policy a colleague can render a poster from your revision, and an administrator can
attach a source backup to your run; both objects are keyed, indexed in `cloud_objects` and charged
under *your* id. See "Object ownership" below for why.

Every segment passes `assertKeySegment` in `worker/services/storage.ts`, which admits only
`/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` and throws `INTERNAL` otherwise. A user-supplied filename in
an object key is three separate primitives at once: path traversal (`../../other-user/...`), key
collision, and a way to smuggle content into a namespace that authorization decisions are made
from. "The user picked this name" is precisely the wrong reason to trust a string.

The leading user id is deliberate. It keeps every object a run produced in one namespace, so
"delete this run's bytes" is a prefix and not a query, and it makes an object filed under the wrong
owner visible in the key rather than only in the database.

**The bucket is private.** There is no public R2 URL and no presigned-URL issuance. Every read
goes through the Worker, which checks ownership and then hands `object.body` straight to the
`Response` — a 12 MB snapshot never materialises in the isolate. Responses carry
`cache-control: private, no-store` and `x-content-type-options: nosniff`, and a download filename
is RFC 5987 encoded so a Japanese filename survives and no quote or newline can break out of the
header.

## How a read is authorised

Three questions, asked in this order, by `worker/middleware/authorize.ts` and nowhere else:

1. **Who is this?** `requireSession` verifies the Better Auth session cookie. No session, no
   request.
2. **May they do this kind of thing?** `requireCapability` checks a capability from
   `@aat/shared`'s vocabulary — `analysis:read`, `cloud:read`, `raw:download`, and so on. Routes
   name capabilities; they never compare role strings.
3. **May they do it to *this*?** `requireRun` / `requireRevision` / `requirePosterFigure` resolve
   the resource and confirm the caller reaches it at the level the route named — `read`,
   `annotate`, `destroy` or `own`.

Reading a snapshot therefore passes through: session → `cloud:read` → the revision's run is not
soft-deleted **and** the caller reaches its owner at `read` → the `cloud_objects` row is not
soft-deleted **and** the caller reaches *its* owner at `read` → the R2 object exists. Every one of
those is a separate `RESOURCE_NOT_FOUND` on failure.

### This deployment is one research team's shared workspace (decided 2026-08-13)

Question 3 used to be "do you own it?", full stop, and this document used to say that "the admin
can read everything" was a policy that had to be chosen deliberately and had not been. The
repository owner has now chosen it.

Registration is by invitation only and every invitation is issued by the owner of the deployment to
a member of their own research group. There is no second tenant. Under those conditions, walling
each researcher off from every other researcher's measurements protected nobody — it meant a group
that shares a drop tower could not share the analyses of the drops.

| Action | Owner | Researcher | Admin | Viewer |
| --- | --- | --- | --- | --- |
| Read run metadata, revisions, metrics, posters | yes | **yes** | **yes** | no |
| Read/download the snapshot (replay, statistics, Excel, custom poster) | yes | **yes** | **yes** | no |
| Read/download the original CSV backup | yes | **yes** | **yes** | no |
| Generate a poster figure, automatic or custom | yes | **yes** | **yes** | no |
| Edit memo, tags, project | yes | **yes** | **yes** | no |
| Delete a run; upload or delete an original CSV | yes | no | **yes** | no |
| Create a revision; upload a snapshot | yes | no | no | no |

The widening is expressed as three capabilities in `packages/shared/src/capabilities.ts`, not as
role comparisons in handlers:

| Capability | Meaning | Held by |
| --- | --- | --- |
| `workspace:read` | May read any member's work in this deployment. | Researcher, Admin |
| `workspace:annotate` | May annotate any member's work — memo, tags, project. | Researcher, Admin |
| `workspace:destroy` | May perform destructive actions on any member's work. | Admin |

Four consequences worth stating, because each is a decision rather than a fallout:

- **A Viewer is unchanged.** Viewers hold no `workspace:*` capability, so every resolver refuses
  them anything they do not own. A Viewer already lacked `analysis:create`; what this policy means
  for them is that their *read* scope did not widen while everyone else's did.
- **The last row is narrower than the rest, for everyone including administrators.** Creating a
  revision on somebody else's run, or filing a snapshot under one, writes into their provenance
  chain — "who analysed this, with what settings" would stop having one answer. Reusing a
  colleague's data means reading their snapshot, not appending to their history.
- **Generating a poster needs `read`, not a write level.** A poster is derived from a revision and
  leaves it untouched. What separates a Viewer from a Researcher there is the `poster:generate`
  capability, not the resolver.
- **There are two listings, and they mean two different things.** `GET /api/v1/runs` is scoped to
  `owner_user_id = caller` in its WHERE clause and keeps meaning "mine"; `GET
  /api/v1/workspace/runs` is the team gallery. Folding every colleague's runs into "my runs" would
  make the one listing a researcher relies on stop meaning anything, and a `?scope=team` parameter
  on the existing route would have made its capability a request-time branch inside the handler —
  so a reader of `index.ts` could no longer tell what `GET /runs` requires.

### `GET /api/v1/workspace/runs` — the team gallery

A read nobody can exercise without already knowing a ULID is a permission nobody can use, so the
widened read needs an enumeration endpoint to be reachable at all. This is it.

| | |
| --- | --- |
| Capabilities | `analysis:read` **and** `workspace:read`, both as middleware |
| Scope | Every member's runs, the caller's own included |
| Query | `search`, `tag`, `projectId`, `from`, `to`, `limit` (≤ 100, default 25), `cursor`, `ownerUserId` |
| Row | the `/runs` row plus `ownerUserId` and `ownerDisplayName` |
| Deleted runs | excluded — the same `IS NULL deleted_at` filter, from the same builder |

The filters come from one shared builder (`runListFilters` in `worker/routes/runs.ts`) so the two
listings cannot drift on a `%`-escape or a `deleted_at` clause; the scope is the only part each
endpoint supplies for itself, because it is the only part they genuinely disagree about.

`ownerDisplayName` is there because a gallery that cannot say *whose* run a row is is a list with
the somebody left out, and the display name is the only identity AAT has — there is no email (see
`worker/auth/identity.ts`). `ownerUserId=` narrows the gallery to one member.

**A Viewer is refused outright**, with `FORBIDDEN` naming `workspace:read`, rather than being
served a quietly narrowed list of their own runs. A narrowed list is worse than a refusal twice
over: a Viewer handed a short gallery has no way to know they were not shown the team's, and an
endpoint that silently omits rows a caller may not see is an existence oracle by omission. The
refusal is byte-identical whether or not any colleague's run exists.

A resource that exists but the caller may not reach answers `RESOURCE_NOT_FOUND`, never
`FORBIDDEN`. `FORBIDDEN` on another user's id confirms the id exists, which turns an id space into
an enumeration oracle over colleagues' run codes. That matters **more** under this policy, not
less: with Viewers still confined to their own runs, the difference between 403 and 404 would tell
a Viewer exactly which run ids the rest of the team holds — and it would tell a Researcher which
runs exist but may not be deleted.

**Administrators are still not exempt from question 3, and `/admin` still serves no research
bytes.** `user:manage`, `invitation:manage`, `audit:read` and `quota:manage` let an administrator
run the deployment; `GET /admin/storage` returns sizes, counts and names and never snapshot or
poster bytes. An administrator reads a colleague's snapshot through `workspace:read` and the
ordinary member routes, where the read is resolved by one middleware, attributed to an actor and
written to the audit log with the owner it touched. A second door through `/admin` would be a
second authorization path to keep correct and a read the owner's audit trail never sees.

### Every access to somebody else's work is in the audit log

`audit_logs.target_owner_user_id` names the member whose work an action touched, and
`writeAuditLog` additionally tags the entry `crossUser: true` in `details` when that is not the
actor. "Who has been reading my measurements?" is the question this policy created, and it cannot
be answered by filtering on `actor_user_id`. `GET /api/v1/admin/audit` accepts
`targetOwnerUserId=` and `crossUserOnly=true` for exactly that query.

The owner is recorded on *every* entry about an owned resource, including the ordinary case where
it equals the actor. An entry that named an owner only when the access was unusual would make the
absence of the field the interesting signal, and an absence is not something a log can prove.

## Object ownership: an object belongs to the run, not to the uploader

`cloud_objects.owner_user_id` and `poster_figures.owner_user_id` are both **the owner of the run**
the object hangs off. So is the leading segment of the R2 key, and so is the account whose quota is
charged. The actor who made the request is recorded in `audit_logs` and nowhere else.

Before the shared-workspace policy the distinction did not exist: only the owner could write
anything under their own run. It exists now because a colleague can render a poster from your
revision and an administrator can attach a source backup to your run, so "who does this PNG belong
to?" became a real question with two possible answers.

It is answered "the run's owner" for one reason, and the reason is deletion. `DELETE
/api/v1/runs/:runId` walks every non-deleted `cloud_objects` row for the run, deletes the R2
object, stamps `deleted_at` and calls `releaseUsage(object.owner_user_id, …)`. If objects inside
one run were charged to several accounts, then:

- the owner would delete their experiment and still be storing — and paying for — the parts of it a
  colleague created, or else the delete would silently reach into a third party's quota;
- a colleague's storage would be consumed by a run they cannot delete, and freeing it would mean
  asking its owner to delete their measurement;
- `GET /admin/storage` would report a per-user total that no single user can act on.

None of those has a good resolution, and all of them are avoided by the artifact living with the
run. The cost is the obvious one and it is accepted deliberately: **a researcher can spend a
colleague's quota** by rendering posters on their runs. That is bounded by
`AAT_MAX_POSTER_BYTES` per figure and by the per-user poster rate limit, it is attributed in the
audit log with both parties, and it is reversible by deleting the figure's run. The alternative —
protecting each researcher's quota from their colleagues — costs an incoherent deletion, which is
not reversible at all.

The same rule is why `DELETE /runs/:runId/source` no longer filters the objects it deletes by the
*caller*: every object under a run belongs to the run's owner, the caller has already been resolved
against that owner at `destroy`, and re-testing each row against the caller would skip exactly the
objects the administrative path exists to remove — leaving the bytes in R2 while reporting a
successful delete.

## Quota accounting: reserve, write, measure, finalise

Storage is charged against `quota_usage`, one row per user, created on first use with
`AAT_DEFAULT_QUOTA_BYTES` (1 GiB) as the ceiling. "Per user" means per *owner of the run* — see
above. The row has three counters and a limit:

| Column | Meaning |
| --- | --- |
| `bytes_used` | Bytes actually stored and committed. |
| `bytes_reserved` | Bytes claimed by uploads currently in flight. |
| `bytes_limit` | The ceiling. Adjustable per user by an admin, never below `bytes_used`. |
| `object_count` | Committed objects. |

The protocol, from `worker/services/quota.ts`:

```
  reserve(declaredBytes)      conditional UPDATE; loses cleanly under concurrency
       │
       ├─ fail ──────────────► QUOTA_EXCEEDED, nothing written
       │
  write to R2                 body read with a hard cap, hashed while it is read
       │
  validate                    ACTUAL byte count and SHA-256, never Content-Length
       │
       ├─ mismatch/oversize ─► delete the object, release the reservation, fail
       │
  finalise(actualBytes)       reservation → usage, in one statement
```

### Why a reservation exists at all

Two uploads that each fit in the remaining space but do not both fit is the case a naive
"check, then write, then add" gets wrong: both read the same free space, both write, and the
account ends up over its limit with no single request having done anything wrong.

The reservation puts the whole decision inside one statement's WHERE clause:

```sql
UPDATE quota_usage
   SET bytes_reserved = bytes_reserved + ?
 WHERE user_id = ?
   AND bytes_used + bytes_reserved + ? <= bytes_limit
```

Exactly one of two concurrent reservations for the last byte can report `changes = 1`. The other
sees zero rows affected and fails with `QUOTA_EXCEEDED`. The overrun becomes impossible rather
than unlikely.

### Why the client's numbers are never trusted

`Content-Length` is a header and a declared SHA-256 is a request field; both are attacker-chosen.
Something has to be reserved *before* the bytes arrive, so the reservation is taken against what
the client claims — but the account is only ever charged what was actually stored, counted while
reading and confirmed afterwards against `R2Object.size`. A client that under-declares has its
body cut off at the reservation, its upload rejected and its reservation released. It does not
get free storage.

`finaliseReservation` releases the reservation and increments usage in one conditional UPDATE,
so a retried finalise charges once. The `bytes_reserved` decrement is clamped with
`MAX(..., 0)`: a reservation the sweeper has already reclaimed has been subtracted once, and a
negative reserved column would give away free quota forever.

### The sweeper covers the client that vanished

`quota_reservations` rows are short-lived — finalised, released, or reclaimed once `expires_at`
passes (`AAT_RESERVATION_TTL_SECONDS`, 900 s). `sweepStaleReservations` claims each stale row
conditionally, gives its bytes back, and deletes the R2 object it orphaned — but only after
confirming no committed `cloud_objects` row claims that key, because a finalised upload owns its
bytes and deleting those would destroy a snapshot the database still points at.

It runs **opportunistically on the upload paths** rather than on a cron. There is no scheduled
trigger in this Worker, and the moment someone is uploading is exactly the moment stale
reservations matter.

## The deletion lifecycle

Deletion is deliberately asymmetric: **soft for the metadata, hard for the bytes.** A "deleted"
run that still costs storage is a bill nobody can explain.

`DELETE /api/v1/runs/:runId` (capability `analysis:delete`, resolved at `destroy` — so the owner or
an administrator, never a colleague):

1. Selects every non-deleted `cloud_objects` row for the run.
2. For each: deletes the R2 object, stamps `cloud_objects.deleted_at`, and calls `releaseUsage`
   to subtract the bytes and decrement `object_count`. The order matters — a failure partway
   through leaves the account charged for objects that still exist, rather than for objects that
   do not.
3. Hard-deletes the `poster_figures` rows belonging to the run's revisions.
4. Stamps `runs.deleted_at`.

Every list and lookup filters on `IS NULL deleted_at`, so a soft-deleted run disappears from the
gallery while its `analysis_revisions` rows remain in place. That is intentional: the audit log
references revision ids, and hard-deleting them would leave the record of what happened pointing
at nothing.

`DELETE /api/v1/admin/users/:userId` (capability `user:manage`) deletes the R2 objects **before**
the user row, because every foreign key cascades from `user.id`: removing the row first would
erase the record of which objects existed, leaving them in the bucket with nothing pointing at
them and no way to find them.

## Outstanding

- ~~**The Run Gallery and Admin console have no UI.**~~ Both exist. The gallery reads
  `GET /workspace/runs` (every member's runs) or `GET /runs` (the caller's own), a Run detail screen
  replays a snapshot without the original CSV, and the seven admin screens cover membership,
  invitations, runs and storage, the renderer breaker, the audit log and settings. What each admin
  screen *cannot* answer is listed on the screen itself rather than guessed at — see the gaps noted
  under the relevant tables above.
- ~~**Part of `apps/web/src/cloud/gateway.ts` still targets routes the Worker does not serve.**~~
  Fixed. Snapshot upload is `PUT /revisions/:revisionId/snapshot` with `declaredBytes`, `sha256` and
  `format` as query parameters, reached through `POST /runs` and `POST /runs/:runId/revisions`; the
  poster calls are the three real routes. `apps/web/test/ui/gateway-routes.test.ts` now asserts that
  every path the gateway constructs resolves to a route the Hono app serves, so a path that does not
  exist fails CI instead of arriving in production as `RESOURCE_NOT_FOUND` — which the gateway reads
  as "this deployment has no cloud half", the reason the original mismatch was invisible for so long.
- ~~**The comment on `poster_figures.status` in `schema.ts` names the wrong vocabulary.**~~ Fixed;
  the comment now names `queued`, `rendering`, `ready`, `failed`, which is what the Worker and
  `@aat/plot-spec` actually use.
- **Snapshots are not compacted or tiered.** Every revision keeps its full-resolution object for
  as long as its run exists. Given the sizes involved this is the right default, but there is no
  lifecycle policy to lean on if it stops being one.
- **No UI consumes the team gallery yet.** `GET /api/v1/workspace/runs` exists and is covered by
  the workerd suite; the screen that would show a colleague's run alongside your own does not.
- **Projects are not shared.** A run can be annotated by any member, but the project it is filed
  under must belong to the run's *owner*, and `GET /projects` lists only the caller's. So a
  colleague editing a run cannot see the projects they are allowed to move it between. Sharing
  projects across the team is a separate decision from sharing runs, and it has not been made.

## Related documents

- `docs/web-architecture.md` — where this sits, and why the browser is authoritative
- `docs/numerical-compatibility.md` — what makes a stored analysis reproducible
- `docs/poster-renderer.md` — the poster half of the model, and the frozen visual contract
- `docs/cost-controls.md` — quotas, limits and spend guards, with the rates
- `docs/auth-security.md` — sessions, invitations, capabilities
