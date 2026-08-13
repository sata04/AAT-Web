# Continuous integration

Three workflows, each with one job to do.

| workflow | trigger | question it answers |
| --- | --- | --- |
| `ci.yml` | pull request, push to `main` | Does this change work? |
| `security.yml` | pull request, push to `main`, daily, weekly | Is anything here known-bad *today*? |
| `deploy.yml` | manual only | Ship what has already been verified. |

Nothing else runs anything. There is no Travis, no CircleCI, no self-hosted
runner, and no plan for one: GitHub-hosted runners are free for public
repositories, and a second provider is a second trust boundary to reason about.

## The one rule the whole arrangement rests on

**A skipped job reports as successful to branch protection.**

That is why every expensive job carries a job-level `if:` and why none of them
uses a workflow-level `paths:` filter. A `paths:` filter stops the *workflow*
from starting, and a required check from a workflow that never started leaves
the pull request at "Expected — waiting for status to be reported" forever. The
`if:` arrangement keeps every check satisfiable while the runners stay idle.

## What runs, and when

```
pull_request ──> identity      always
                 changes       always  ─┬─> web         if changes.web
                                        ├─> numerical   if changes.numerical
                                        ├─> poster      if changes.poster
                                        └─> e2e         if changes.e2e

                 scope         always  ──> dependencies if scope.deps
                 secrets       always

push: main ────> the same, with the detector forced to "everything"
```

`identity` and `changes` used to be steps inside the big job. They are separate
now for one reason: the big job is conditional, and the commit-identity check
must not be skipped along with it. A documentation-only pull request still gets
its committer checked.

## Change detection

`scripts/detect-changes.mjs` maps changed paths to jobs. Its rules are ordinary
code with ordinary unit tests (`scripts/detect-changes.test.mjs`, run by
`pnpm test`), because a wrong rule does not fail loudly — it produces a green
tick for a job that never ran.

Run it by hand against any range:

```bash
node scripts/detect-changes.mjs --base main --head HEAD
printf 'docs/ci.md\n' | node scripts/detect-changes.mjs --files-from -
```

The routing, in one table. `web` is lint + typecheck + the Node/DOM/workerd
suites + build + the Worker bundle gate; `numerical` is the vendored Python
oracle and the golden check; `poster` is the renderer suite, the container build
and the suite again inside the image; `e2e` is Playwright against a real local
stack.

| change | web | numerical | poster | e2e |
| --- | :-: | :-: | :-: | :-: |
| `docs/**`, any `*.md`, `.claude/**` | | | | |
| `apps/web/src/**`, `public/**`, `index.html` | ● | | | ● |
| `apps/web/worker/**` | ● | | | ● |
| `apps/web/migrations/**` | ● | | | ● |
| `apps/web/test/{ui,dom,worker}/**`, `vitest*.config.ts` | ● | | | |
| `apps/web/test/fixtures/**` | ● | | | ● |
| `apps/web/e2e/**`, `playwright.config.ts` | | | | ● |
| `apps/web/{vite,wrangler,tsconfig,package}` | ● | | | ● |
| `packages/analysis-core/**` | ● | ● | | ● |
| `packages/plot-spec/**` | ● | | ● | ● |
| `packages/shared/**` | ● | | | ● |
| `reference/python/**` | | ● | | |
| `tests/golden/**` | ● | ● | | |
| `tests/fixtures/**` | ● | ● | | ● |
| `poster-renderer/**` (incl. `Dockerfile`, `requirements.txt`) | | | ● | ● |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json` | ● | | | ● |
| `biome.json` | ● | | | |
| `package.json` (root) | ● | ● | ● | ● |
| `.github/**`, `scripts/**`, `.githooks/**`, `renovate.json5`, `.gitleaks.toml` | ● | ● | ● | ● |
| anything else | ● | ● | ● | ● |

Three of those deserve their reasoning stated, because they look like
over-caution and are not:

- **`packages/plot-spec/**` runs the poster job.** The spec is the contract the
  Python renderer consumes. Changing it on one side without the other is exactly
  the failure the visual-contract tests exist to catch.
- **`poster-renderer/**` runs the E2E suite.** `renderer-integration.spec.ts`
  drives that image through the Worker. A change to the renderer's HTTP contract
  breaks it and the renderer's own pytest suite would not notice.
- **`pnpm-lock.yaml` does *not* run the Python jobs.** An npm lockfile cannot
  move a Python wheel. This is the single largest saving in the table: Renovate
  opens a `lockFileMaintenance` pull request every Monday, and each one used to
  install NumPy and build a container image to prove a JavaScript dependency
  bump.

Anything the table does not cover turns every job on and is reported as
`unclassified` in the job log, which is the signal to add a rule.

### Why `main` ignores all of it

A push to `main` runs the detector with `--all`. If a rule above is wrong, the
pull request that exercised it went green without the job that would have caught
it — and this is where that gets noticed. Merges are rare; pushes to a branch
under review are not, which is the asymmetry the whole design leans on.

## Concurrency

```yaml
group: ci-${{ github.event.pull_request.number || github.ref }}
cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

Superseding a pull request's own earlier run is the largest single saving on an
actively edited branch. Runs on `main` are never cancelled: they are the record
of what that history does, and cancelling one would leave a commit with no
result.

There is deliberately no `push` trigger for topic branches. A branch with an
open pull request would otherwise be checked twice per commit — once as `push`,
once as `pull_request` — on the same tree for the same answer.

## The end-to-end suite

It is gated, never trimmed. All of it runs, or none of it: `retries: 0`,
`workers: 1`, no mocks, a real Chromium against a real `workerd` with a real
local D1 and R2, a Chromium virtual authenticator completing real passkey
ceremonies, and the pinned Python renderer under Docker.

The CI job builds `aat-poster-renderer:ci` before running it. Without that image
the harness reports the container as missing and two specs skip themselves —
and a skip in CI is indistinguishable from a pass. Building it is how
"the browser's plot spec reaches the real renderer" stays a claim CI can make.

The suite also typechecks itself there (`tsc -p e2e/tsconfig.json`). It is a
separate TypeScript programme that `tsc -b` in `apps/web` does not include, and
Playwright transpiles without checking, so nothing else would.

## Caching

`actions/setup-node` with `cache: pnpm`, which caches the pnpm **store** keyed on
`pnpm-lock.yaml`. Not `node_modules`: restoring a tree of modules reinstates a
dependency graph without re-running the resolution that `pnpm-workspace.yaml`'s
supply-chain gates hook into, and a poisoned cache would be indistinguishable
from a clean install. A store cache is content-addressed by integrity hash, so a
corrupted entry is rejected rather than trusted. `--frozen-lockfile` stays.

The poster-renderer container build has **no** cache, on purpose. Its whole value
is being reproducible from pinned inputs — base image by digest, every wheel by
hash, `--only-binary=:all:` — and a mutable cache is a mutable input to the one
artefact where that is the point. A BuildKit cache mount is not available either:
the Dockerfile's runtime stage has to stay byte-for-byte what `deploy.yml` ships.
The build costs a couple of minutes and runs in parallel with everything else.

## Deployment

`deploy.yml` is manual-only and unchanged by any of this. Its `verify` job
repeats work `ci.yml` already did, deliberately: it runs at the exact commit
being deployed, produces the artefacts the credential-bearing job consumes, and
must not depend on a run that happened on a different tree. See the design note
at the top of that file — the split between "runs repository code" and "holds
production credentials" is the thing it exists to protect, and nothing in this
document may erode it.
