# Deployment

How AAT Web reaches production, and why the procedure is shaped the way it is.

**This repository has never been deployed.** `apps/web/wrangler.jsonc` carries deliberately
invalid placeholders and `.github/workflows/deploy.yml` is `workflow_dispatch`-only. Both are
described below, together with what has to be provisioned before either can change.

Nothing in this document should be executed casually. The steps that create Cloudflare resources
cost money, and the step that sets `AAT_RP_ID` is effectively irreversible — see
[Getting the relying-party id wrong is not recoverable](#getting-the-relying-party-id-wrong-is-not-recoverable).

## The trust boundary is the whole design

`deploy.yml` is split into two jobs, and the split is the point rather than an optimisation:

| | `verify` | `deploy` |
| --- | --- | --- |
| Holds Cloudflare credentials | no | yes |
| Holds Doppler / OIDC capability | no | yes |
| Runs `pnpm install` scripts, linters, tests | yes | install only |
| Runs `pnpm build` | yes | **no** |
| Runs `docker build` | yes | **no** |
| Reads `poster-renderer/Dockerfile` | yes | **no** |
| Produces the client bundle and container image | yes | consumes them as artefacts |

The threat model is "the repository itself is hostile" — a compromised dependency, or a commit
nobody read closely enough. `id-token: write` can only be granted per job, and GitHub injects the
OIDC request variables into *every step* of the job that has it; they cannot be unset per step. Any
code that runs in `deploy` can therefore mint an OIDC token and read the entire Doppler production
config. There is no way to fence that off from inside, so the response is to run as little as
possible there.

Concretely: `verify` builds and tests the container image and uploads it as an artefact, and
`deploy` pushes that artefact. Wrangler's convenient "build my Dockerfile during deploy" path is
deliberately unused, because it would put a Dockerfile — and everything it can `RUN` — inside the
credentialled job.

The accepted residual risk is `wrangler` itself, which runs in `deploy` and does have that reach.
It is already trusted with the Cloudflare token and the Worker secrets, so the marginal exposure is
small, and `renovate.json5` holds it and the pinned actions to a 30-day release age for exactly
this reason. See [supply-chain.md](./supply-chain.md).

**Do not "simplify" this by merging the jobs, and do not add a build step to `deploy`.**

## Required Cloudflare resources

Everything below lives in one Cloudflare account on the **Workers Paid** plan. Containers are not
available on the free plan. See [cost-controls.md](./cost-controls.md) for what each of these bills
and why the guards exist.

| Resource | Name | Created by |
| --- | --- | --- |
| Workers Paid subscription | — | dashboard |
| Worker | `aat-web` | first `wrangler deploy` |
| D1 database | `aat-db` | `wrangler d1 create aat-db` |
| R2 bucket (private) | `aat-objects` | `wrangler r2 bucket create aat-objects` |
| Container application | `aat-poster-renderer` | first deploy with the `containers` binding |
| Custom domain | the production hostname | the `Ensure custom domain` step |

The R2 bucket must stay private. There is no public R2 URL and no signed-URL issuance anywhere in
this codebase: every read goes through the Worker so ownership is checked on the way out
(see [cloud-data-model.md](./cloud-data-model.md)).

### Placeholders that must be replaced

Two account-scoped identifiers are committed as invalid placeholders. They are not secrets — they
appear in `wrangler.jsonc`, which is in version control — but a wrong value must fail loudly rather
than write to some other account:

| Location | Placeholder | Filled in from |
| --- | --- | --- |
| `d1_databases[0].database_id` | `00000000-0000-0000-0000-000000000000` | Doppler `AAT_D1_DATABASE_ID` (the id printed by `wrangler d1 create aat-db`) |
| `containers[0].image` | `registry.cloudflare.com/000…0/aat-poster-renderer:latest` | the digest the deploy step captures after pushing the image |

**The committed file is never the file that is deployed, and it stays invalid on purpose.** Wrangler
performs no variable substitution inside its own configuration, so
`apps/web/scripts/resolve-wrangler-config.mjs` produces a deploy-time copy with these two values
filled in, and every step that reads configuration — the D1 migration and the deploy itself — is
passed that copy with `--config`. The script asserts each placeholder matched exactly once, so an
edit that moves or renames one fails the deploy instead of shipping a placeholder.

A deploy attempted from a developer machine without that step therefore fails, which is the intent.

Wrangler also refuses an image whose account id is not the account being deployed to, so even a
resolution that produced the wrong account fails closed rather than pulling a stranger's image.

## Secrets

Secrets are declared in `wrangler.jsonc` under `"secrets".required` and never committed. Anything
that would identify the deployment is a secret rather than a `var`, which is why the production
hostname does not appear in this repository.

| Key | What it is |
| --- | --- |
| `BETTER_AUTH_SECRET` | Better Auth's signing secret. 32+ bytes of randomness. |
| `BETTER_AUTH_URL` | The auth base URL, i.e. `https://<production hostname>`. |
| `AAT_RP_ID` | The WebAuthn relying-party id — the registrable domain, no scheme, no port, no path. |
| `AAT_RP_NAME` | Human-readable name shown by the authenticator during a ceremony. |
| `AAT_TRUSTED_ORIGINS` | The exact origins allowed to complete a passkey ceremony, including scheme. |

`apps/web/worker/config.ts` refuses to start an auth flow when these are absent rather than
deriving a default from the request's `Host` header, which an attacker controls. That refusal is
load-bearing — do not add a fallback.

### Getting the relying-party id wrong is not recoverable

A passkey is bound to the RP ID it was created under. Change `AAT_RP_ID` after users have
registered and their authenticators simply stop offering their credentials — which is
indistinguishable, from the user's side, from every one of them losing their key at once. There is
no migration path; each user has to be recovered individually by an administrator.

Decide the production hostname **before** the first real registration, and treat `AAT_RP_ID` as
permanent thereafter. `AAT_TRUSTED_ORIGINS` may be extended safely; `AAT_RP_ID` may not be changed.

### Doppler

The deploy job reads secrets from Doppler project `aat-web`, config `prd`, authenticating with
GitHub's OIDC token rather than a long-lived service token. Required keys, all validated by the
workflow's fail-closed check before anything is deployed:

```
CF_DEPLOY_TOKEN_VALUE     Cloudflare API token (see scopes below)
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID        zone owning the production hostname
DEPLOY_HOSTNAME           the production hostname
BETTER_AUTH_SECRET
BETTER_AUTH_URL
AAT_RP_ID
AAT_RP_NAME
AAT_TRUSTED_ORIGINS
AAT_D1_DATABASE_ID        id of the D1 database; substituted into wrangler.jsonc at deploy time
```

The Cloudflare API token needs: Workers Scripts edit, D1 edit, R2 edit, Containers/Cloudchamber
edit, and Workers Domains edit on the zone. Scope it to the one account; do not use a global API
key.

On the Doppler side, constrain the OIDC identity with claim rules on `aud`, `sub`, `ref` and
`job_workflow_ref` so that only this job, on `main`, in this repository qualifies. Without those
rules any workflow in any repository that knows the identity id could read the config.

The identity id itself is stored as a **GitHub Environment secret** named `DOPPLER_IDENTITY_ID` on
an environment called `production`. Use that environment's protection rules (required reviewers) as
the human gate on deployment. The workflow fails with a pointer to this document if the secret is
unset, and `deploy` additionally refuses to run when `github.ref` is not `refs/heads/main`, so a
`workflow_dispatch` from a topic branch cannot reach the credentials.

## Why the automatic trigger is off

`deploy.yml` is `workflow_dispatch`-only, and that is intentional rather than unfinished. None of
the infrastructure above exists yet, so a `push` trigger on `main` would fail on every commit —
training everyone to ignore a red Deploy badge, which is exactly how a genuine deployment failure
gets missed later.

Restore the automatic trigger once the resources and secrets are provisioned, by adding:

```yaml
  push:
    branches: ["main"]
```

Leave it off until then. **Do not turn it on as part of an unrelated change.**

## Order of operations for a first deployment

1. Provision the Cloudflare resources listed above.
2. Replace the two placeholders in `wrangler.jsonc` and commit that change.
3. Create the Doppler `aat-web/prd` config and populate every key.
4. Create the Doppler OIDC identity and its claim rules.
5. Create the GitHub `production` environment and set `DOPPLER_IDENTITY_ID`.
6. Run the Deploy workflow manually from `main`.
7. Bootstrap the first administrator (below).
8. Run the smoke tests (below).

Migrations are applied **before** `wrangler deploy`, so the schema the new code expects is already
in place when it starts serving. Schema changes follow expand/migrate/contract, which is what makes
that ordering safe: a migration must not break the code currently running.

## Bootstrapping the first administrator

There is no open sign-up, no password login and no HTTP bootstrap endpoint. A fresh deployment
therefore has a chicken-and-egg problem: only an administrator can issue an invitation, and there
is no administrator yet.

The resolution is that `registration_invites.created_by_user_id` is nullable precisely for this
case — "the bootstrap invitation of a fresh deployment, which has no administrator yet". The first
invitation is inserted directly into D1 by whoever holds the Cloudflare credentials.

Generate a token and its hash locally. **The plaintext is the only copy that will ever exist**; only
the SHA-256 is stored, and the database, its backups and any query log derived from it contain
nothing redeemable.

```bash
TOKEN=$(node -e 'const b=new Uint8Array(32);crypto.getRandomValues(b);process.stdout.write(Buffer.from(b).toString("base64url"))')
HASH=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$TOKEN")
echo "token: $TOKEN"
```

Insert the invitation. `id` is any ULID; timestamps are epoch milliseconds; give it a short expiry
and redeem it immediately.

> **Every `wrangler d1 execute` below needs a resolved configuration.** The
> committed `apps/web/wrangler.jsonc` carries a deliberately invalid
> `database_id`, so running these commands against it fails with
> `The database 00000000-0000-0000-0000-000000000000 could not be found`. That
> placeholder is the point — it stops a stray local deploy writing into somebody
> else's account — but it means an operator has to generate the real
> configuration first, the same way the deploy job does:
>
> ```bash
> cd apps/web
> export CLOUDFLARE_API_TOKEN=$(doppler secrets get CF_DEPLOY_TOKEN_VALUE --project aat-web --config prd --plain)
> export CLOUDFLARE_ACCOUNT_ID=$(doppler secrets get CLOUDFLARE_ACCOUNT_ID --project aat-web --config prd --plain)
> AAT_D1_DATABASE_ID=$(doppler secrets get AAT_D1_DATABASE_ID --project aat-web --config prd --plain) \
> POSTER_RENDERER_IMAGE="registry.cloudflare.com/${CLOUDFLARE_ACCOUNT_ID}/aat-poster-renderer:latest" \
>   node scripts/resolve-wrangler-config.mjs wrangler.local.jsonc
> ```
>
> `POSTER_RENDERER_IMAGE` is never read by a `d1 execute`, but wrangler validates
> the whole configuration before running any command. A placeholder such as
> `unused` is rejected — "does not appear to be a valid path to a Dockerfile, or a
> valid image registry path" — and one naming another account is refused too. The
> value above is syntactically valid and belongs to this account, which is all the
> validator asks of it.
>
> Then pass `--config wrangler.local.jsonc` to every command in this section, and
> delete the file afterwards — it is gitignored, but it names the account.


```bash
cd apps/web
pnpm exec wrangler d1 execute aat-db --remote --config wrangler.local.jsonc --command "
  INSERT INTO registration_invites
    (id, token_hash, kind, role, display_name, created_by_user_id,
     created_at, expires_at, status)
  VALUES
    ('<ulid>', '$HASH', 'registration', 'Admin', '<display name>', NULL,
     $(date +%s000), $(( $(date +%s) * 1000 + 3600000 )), 'pending');
"
```

Then open `https://<production hostname>/register?token=$TOKEN` and complete passkey registration.
The token is exchanged immediately for a short-lived registration context and scrubbed from the
URL; the invitation is consumed atomically when the ceremony completes.

Afterwards, forget the plaintext. Every subsequent invitation is issued through the Admin console,
which shows the registration URL exactly once at creation time and can never retrieve it again.

Verify the result before going further — a deployment whose only administrator is not actually an
administrator is worth catching now:

```bash
pnpm exec wrangler d1 execute aat-db --remote --config wrangler.local.jsonc \
  --command "SELECT id, name, role, banned FROM user;"
```

## Smoke tests after a deployment

Run these in order. The first three need no account, which is the point: local analysis is the
product and must work for a signed-out visitor with no network.

1. **The SPA loads.** `GET https://<hostname>/` returns the shell. Static assets are served without
   invoking the Worker at all (`run_worker_first` covers only `/api/*`), so this exercises Workers
   Static Assets rather than the Worker.
2. **Local analysis works signed out.** Open a CSV, confirm the graph renders, select a range,
   confirm range statistics, export XLSX. None of this should produce a network request to `/api`.
3. **Offline still works.** Reload with the network disabled; the service worker serves the shell
   and analysis continues to function.
4. **Auth is reachable and refuses cleanly.** `GET /api/auth/…` responds; an unauthenticated
   request to a protected `/api/v1/*` route returns `AUTH_REQUIRED`, not a 500. A 500 here usually
   means a missing secret.
5. **Register the bootstrap administrator** as above, and confirm the raw token is gone from the
   address bar afterwards.
6. **Sign out and sign back in** with the passkey.
7. **A full cloud round trip.** Analyse a file, confirm the revision is saved, confirm exactly one
   automatic poster is produced and reaches `ready`, and confirm the Run Gallery shows it.
8. **The container slept.** Wait past the sleep-after timeout and confirm no instance is still
   running. A container that stays warm is a container being billed.
9. **Quota and audit.** Confirm the Admin console reports non-zero storage for the run just created
   and that the audit log contains the registration and the poster render.

## Rollback

There are three independent things that can be rolled back, and they are not equally safe.

**The Worker.** Re-run the Deploy workflow from an earlier commit on `main`, or use
`wrangler rollback` / `wrangler deployments` for an immediate revert to the previous version. This
is the fast path and is safe as long as the schema has not moved under it.

**The container image.** `containers[0].image` references an immutable digest once deployed, so
rolling the Worker back also rolls back the renderer. A poster rendered by an older image may
differ from one rendered by the newer image — that is precisely what the frozen visual contract and
`posterPresetVersion` exist to make visible rather than silent. See
[poster-renderer.md](./poster-renderer.md).

**D1 migrations do not roll back.** `wrangler d1 migrations apply` only rolls forward, and there is
no down-migration mechanism. This is the reason for expand/migrate/contract: the expand step must
be compatible with the code already running, so a Worker rollback never lands on a schema that
cannot serve it. If a migration is genuinely wrong, the fix is a new migration, plus — if data was
destroyed — a restore from D1 Time Travel, which is a point-in-time restore of the whole database
and therefore loses everything written since. Treat the contract step of any migration as the
irreversible one and land it a deploy later than the expand step.

R2 objects are not versioned in this configuration. Deletion is a soft delete in D1 followed by an
object delete; once the object is gone it is gone.

## What this document deliberately does not do

It does not deploy anything, and it does not ask a contributor to supply production credentials in
order to develop or test. Every suite in this repository runs against local fixtures, a local D1
with the committed migrations applied, and a locally built container image. If a test appears to
need production credentials, that is a bug in the test.

## Related documents

- [web-architecture.md](./web-architecture.md) — what the system is and why the cloud half is optional
- [auth-security.md](./auth-security.md) — passkeys, invitations, sessions, recovery
- [cloud-data-model.md](./cloud-data-model.md) — D1, R2, revisions, quotas
- [cost-controls.md](./cost-controls.md) — what bills, and every guard against it
- [poster-renderer.md](./poster-renderer.md) — the container and the frozen visual contract
- [supply-chain.md](./supply-chain.md) — dependency policy and release-age gates
