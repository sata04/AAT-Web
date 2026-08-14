#!/usr/bin/env node

/**
 * Decide which CI jobs a change actually needs.
 *
 * ## Why this is code rather than `on.pull_request.paths`
 *
 * A workflow-level `paths:` filter stops the *workflow* from starting. A branch
 * protection rule that requires a check from a workflow which never started
 * waits for it forever, so the pull request sits at "Expected — waiting for
 * status to be reported" and cannot be merged. The supported way out is the
 * opposite arrangement: one tiny job always runs, publishes its findings as job
 * outputs, and every expensive job carries a job-level `if:`. GitHub reports a
 * skipped job as successful to branch protection, so the required checks stay
 * satisfiable while the runners stay idle.
 *
 * ## Why it is a script rather than a third-party action
 *
 * `docs/supply-chain.md` is the long answer. The short one: every action in this
 * repository is pinned to a commit SHA and reviewed, and a paths-filter action
 * would be one more package running in a job that reads the repository, in
 * exchange for `git diff --name-only` and a table. That trade is not worth
 * making.
 *
 * ## The rule that matters most
 *
 * Skipping the wrong job does not fail loudly — it produces a green tick for
 * work that never happened, which is worse than a slow pipeline. So:
 *
 *  - a path that matches no rule turns *everything* on and is reported as
 *    unclassified, which is the signal to add a rule here;
 *  - anything that could plausibly reach a job is routed to it, even when the
 *    connection is indirect (`poster-renderer/**` reaches the end-to-end suite
 *    because the browser sends a plot spec through the Worker to that renderer);
 *  - pushes to `main` ignore this file entirely and run the full matrix, so a
 *    rule that is wrong is caught at the merge rather than never.
 *
 * ## The other output
 *
 * `deps_only` is not a routing decision — `.github/workflows/deploy.yml` reads it
 * to decide whether a push to main ships without anyone asking. It is answered by
 * the path rules *and* by `inspectPackageJson`, because "only package.json
 * changed" is the same sentence for a version bump and for a rewritten build
 * script.
 *
 * ## Usage
 *
 *   node scripts/detect-changes.mjs --base <sha> --head <sha>
 *   node scripts/detect-changes.mjs --files-from <path|->
 *   node scripts/detect-changes.mjs --all
 *
 * Writes `name=value` lines to $GITHUB_OUTPUT when set, and a readable summary
 * to stdout either way.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'

/** The expensive jobs in .github/workflows/ci.yml, in the order they are reported. */
export const JOBS = ['web', 'numerical', 'poster', 'e2e']

const ALL = JOBS
const NONE = []

/**
 * Path rules, evaluated in order; the first match wins.
 *
 * `category` is what the change is, and exists so the CI log can say *why* a job
 * was chosen. `jobs` is which of ci.yml's jobs that category can break.
 *
 * The job names mean:
 *   web        lint, typecheck, the Node/DOM/workerd suites, the client build,
 *              the wrangler dry run and the Worker bundle-size gate.
 *   numerical  the vendored Python reference and `generate_golden.py --check`.
 *   poster     the renderer's pytest suite, the container build, and the suite
 *              again inside the image.
 *   e2e        Playwright against a real local stack.
 */
export const RULES = [
  // -------------------------------------------------------------------------
  // Prose. Nothing in this repository executes Markdown.
  // -------------------------------------------------------------------------
  { category: 'docs', jobs: NONE, match: /(^|\/)[^/]+\.md$/ },
  { category: 'docs', jobs: NONE, match: /^docs\// },
  { category: 'docs', jobs: NONE, match: /^LICENSE(\.[^/]*)?$/ },
  // Agent tooling. Read by Claude Code, by nothing that CI runs.
  { category: 'agent-tooling', jobs: NONE, match: /^\.claude\// },

  // -------------------------------------------------------------------------
  // Anything that can change how CI itself behaves runs the whole matrix. This
  // is also the rule that makes a change to *this file* self-checking.
  // -------------------------------------------------------------------------
  { category: 'ci-config', jobs: ALL, match: /^\.github\// },
  { category: 'ci-config', jobs: ALL, match: /^scripts\// },
  { category: 'ci-config', jobs: ALL, match: /^\.githooks\// },
  { category: 'ci-config', jobs: ALL, match: /^renovate\.json5$/ },
  { category: 'ci-config', jobs: ALL, match: /^\.gitleaks\.toml$/ },

  // -------------------------------------------------------------------------
  // Root build configuration.
  //
  // package.json holds every `pnpm <script>` CI invokes and the pnpm version
  // itself, so it reaches all four jobs — `golden:check` is defined there too.
  // The rest are narrower and are described where they differ.
  // -------------------------------------------------------------------------
  { category: 'root-config', jobs: ALL, match: /^package\.json$/ },
  // The supply-chain gates and the workspace layout. No effect on the pinned
  // Python interpreters, which CI installs with pip directly.
  { category: 'root-config', jobs: ['web', 'e2e'], match: /^pnpm-workspace\.yaml$/ },
  // Inherited by apps/web/tsconfig.json, which e2e/tsconfig.json extends.
  { category: 'root-config', jobs: ['web', 'e2e'], match: /^tsconfig\.base\.json$/ },
  // Only `pnpm lint`, which lives in the web job.
  { category: 'root-config', jobs: ['web'], match: /^biome\.json$/ },

  // -------------------------------------------------------------------------
  // Dependencies.
  //
  // The npm lockfile cannot move a Python wheel, so a Renovate
  // `lockFileMaintenance` pull request — one a week, every week — no longer
  // installs NumPy or builds a container image to prove it.
  // -------------------------------------------------------------------------
  { category: 'npm-lockfile', jobs: ['web', 'e2e'], match: /^pnpm-lock\.yaml$/ },

  // -------------------------------------------------------------------------
  // The application.
  // -------------------------------------------------------------------------
  // The Pages front door: the Function that forwards /api/* to the private
  // Worker, and its own TypeScript programme. Every authenticated request goes
  // through it, so it reaches the web job (which typechecks it) and the
  // end-to-end suite (which is the only thing that exercises the hop).
  { category: 'pages-front-door', jobs: ['web', 'e2e'], match: /^apps\/web\/pages\// },
  // The suite and its harness. Typechecked and run by the e2e job alone.
  { category: 'e2e-suite', jobs: ['e2e'], match: /^apps\/web\/e2e\// },
  { category: 'e2e-suite', jobs: ['e2e'], match: /^apps\/web\/playwright\.config\.ts$/ },
  // Test configuration and the Node/DOM/workerd suites: the web job.
  { category: 'web-tests', jobs: ['web'], match: /^apps\/web\/vitest[^/]*\.config\.ts$/ },
  { category: 'web-tests', jobs: ['web'], match: /^apps\/web\/test\/(ui|dom|worker)\// },
  // Fixtures are shared: the workerd suite reads them and so does the browser.
  { category: 'web-fixtures', jobs: ['web', 'e2e'], match: /^apps\/web\/test\/fixtures\// },
  // The Worker, its routes and its schema. The browser talks to all of it.
  { category: 'worker', jobs: ['web', 'e2e'], match: /^apps\/web\/worker\// },
  { category: 'worker', jobs: ['web', 'e2e'], match: /^apps\/web\/worker-configuration\.d\.ts$/ },
  // Migrations are applied for real by both the workerd suite and the E2E stack.
  { category: 'd1-migrations', jobs: ['web', 'e2e'], match: /^apps\/web\/migrations\// },
  { category: 'd1-migrations', jobs: ['web', 'e2e'], match: /^apps\/web\/drizzle\.config\.ts$/ },
  // The React application.
  { category: 'web-ui', jobs: ['web', 'e2e'], match: /^apps\/web\/src\// },
  { category: 'web-ui', jobs: ['web', 'e2e'], match: /^apps\/web\/public\// },
  { category: 'web-ui', jobs: ['web', 'e2e'], match: /^apps\/web\/index\.html$/ },
  // Deployment shape: the bundle, the bindings, the generated headers.
  {
    category: 'web-config',
    jobs: ['web', 'e2e'],
    match: /^apps\/web\/(vite\.config\.ts|wrangler[^/]*\.jsonc?|tsconfig\.json|package\.json)$/,
  },
  { category: 'web-config', jobs: ['web', 'e2e'], match: /^apps\/web\/scripts\// },
  // Anything else under apps/web that no rule above named.
  { category: 'web-other', jobs: ['web', 'e2e'], match: /^apps\/web\// },

  // -------------------------------------------------------------------------
  // Workspace packages.
  // -------------------------------------------------------------------------
  // The numerical engine. `docs/numerical-compatibility.md`: its output is
  // compared against the vendored Python oracle, so it reaches the golden job.
  { category: 'analysis-core', jobs: ['web', 'numerical', 'e2e'], match: /^packages\/analysis-core\// },
  // The poster specification. The Python renderer consumes it, so a change here
  // is a change to the visual contract on both sides of the boundary.
  { category: 'plot-spec', jobs: ['web', 'poster', 'e2e'], match: /^packages\/plot-spec\// },
  { category: 'shared', jobs: ['web', 'e2e'], match: /^packages\/shared\// },
  // A new workspace package nobody has taught this file about.
  { category: 'packages-other', jobs: ALL, match: /^packages\// },

  // -------------------------------------------------------------------------
  // The numerical oracle and its fixtures.
  // -------------------------------------------------------------------------
  // The vendored desktop version is restated in the web app's about line and in the poster
  // watermark, and `scripts/check-versions.mjs` — which runs inside `pnpm test`, i.e. the web job
  // — is what fails when a bump reaches this file and not the others. Routing it to `numerical`
  // alone would let exactly the half-finished bump the checker exists to catch go green.
  {
    category: 'desktop-baseline-version',
    jobs: ['web', 'numerical', 'poster', 'e2e'],
    match: /^reference\/python\/REFERENCE_VERSION\.txt$/,
  },
  { category: 'python-reference', jobs: ['numerical'], match: /^reference\/python\// },
  // Goldens are generated by the reference and read by the TypeScript suite, so
  // both sides have to agree again.
  { category: 'golden-fixtures', jobs: ['web', 'numerical'], match: /^tests\/golden\// },
  // The CSVs are read by the TypeScript suite, the Python reference and the
  // browser in the E2E run.
  { category: 'csv-fixtures', jobs: ['web', 'numerical', 'e2e'], match: /^tests\/fixtures\// },

  // -------------------------------------------------------------------------
  // The poster renderer.
  //
  // Reaches the E2E suite because `renderer-integration.spec.ts` drives this
  // exact image through the Worker — a change to the renderer's HTTP contract
  // breaks that and nothing in the renderer's own pytest suite would notice.
  // -------------------------------------------------------------------------
  { category: 'poster-renderer', jobs: ['poster', 'e2e'], match: /^poster-renderer\// },
]

/**
 * What a vulnerability scanner would have to re-read.
 *
 * Orthogonal to the job routing above, because it crosses the same boundaries
 * from the other direction: `poster-renderer/requirements.txt` is a dependency
 * manifest *and* a visual-contract file, and `.github/workflows/security.yml`
 * needs to know the first thing while ci.yml needs the second.
 *
 * Matched with the same fail-open bias: an unclassified path sets this too,
 * because a scanner that did not run is a scanner that found nothing.
 */
const DEPENDENCY_MANIFESTS = [
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)package\.json$/,
  /(^|\/)requirements(\.[^/]+)?\.(txt|in)$/,
  /(^|\/)Dockerfile$/,
  /^osv-scanner\.toml$/,
  // The scanner's own pins and the script that scopes it. Editing the pinned
  // osv-scanner version changes what a scan would find, so the change that
  // edits it is the one that should re-run it.
  /^\.github\//,
  /^scripts\//,
]

/**
 * What a dependency update — and nothing else — looks like, by path.
 *
 * `.github/workflows/deploy.yml` deploys automatically only when every changed
 * path matches one of these. The gate is a property of the CHANGE, not of who
 * made it: checking for `renovate[bot]` would trust an author name that appears
 * in a commit anyone can write, and a branch-name check trusts even less.
 *
 * Deliberately narrow. `pnpm-workspace.yaml` is absent because it holds the
 * supply-chain policy, and the Python requirement files and the Dockerfile are
 * absent because they are the poster renderer's visual contract — Renovate never
 * auto-merges those, and neither should a deploy.
 *
 * The path is necessary and NOT sufficient for a `package.json`: see
 * `inspectPackageJson` below, which is the other half of the gate.
 */
const DEPENDENCY_ONLY = [/^pnpm-lock\.yaml$/, /(^|\/)package\.json$/]

/** Is this path one of the manifests that has to be read as well as matched? */
const PACKAGE_JSON = /(^|\/)package\.json$/

/**
 * The `package.json` fields that hold nothing but dependency version constraints.
 *
 * Everything a package.json can carry that is NOT in this list changes what runs
 * rather than what is installed, so it is judged by the fall-through rule in
 * `inspectPackageJson` — which refuses. That includes `overrides`, `resolutions`
 * and `pnpm.*`: they are dependency-shaped, but they redirect resolution for the
 * whole graph, which is a supply-chain policy decision and not a version bump.
 */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

/**
 * A version constraint that resolves against the registry, and nothing else.
 *
 * A semantic diff that only asked "did just the dependency fields move?" would
 * accept `"papaparse": "5.5.4"` becoming `"papaparse": "git+https://…"`,
 * `"npm:something-else@1.0.0"`, `"file:../elsewhere"` or `"github:owner/repo"`.
 * Every one of those is a value change inside `dependencies` and every one of
 * them installs code from somewhere nobody reviewed — which is a worse outcome
 * than the `scripts` edit this gate was tightened to catch.
 *
 * So a *changed* constraint has to look like a plain range on both sides: the
 * semver alphabet, at least one digit, and none of the `:` `/` `@` `#` that
 * every alternative protocol needs to say where else to fetch from. Constraints
 * that do not change are never examined, which is what keeps the `workspace:*`
 * entries in `apps/web/package.json` out of it.
 */
const REGISTRY_RANGE = /^[0-9A-Za-z.+*\-|^~<>= ]*[0-9][0-9A-Za-z.+*\-|^~<>= ]*$/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A copy of a parsed manifest with the dependency fields removed. */
function withoutDependencyFields(manifest) {
  const rest = { ...manifest }
  for (const field of DEPENDENCY_FIELDS) delete rest[field]
  return rest
}

/**
 * Decide whether one `package.json` diff is a dependency version bump and nothing else.
 *
 * ## Why the path is not enough
 *
 * "Only `package.json` and `pnpm-lock.yaml` changed" reads like a safe
 * description of a Renovate update, and it is not one. `package.json` is also
 * where every command CI and the deploy run is defined — `build`, `test`,
 * `check:bundle` — plus `packageManager`, which decides which pnpm executes them,
 * and `engines`. A diff that edits `scripts.build` and touches nothing else has
 * the exact path signature of a dependency bump and arbitrary effect on what
 * ships, unreviewed, straight to production.
 *
 * So the paths select which files to read, and this decides what the read says:
 *
 *  - everything outside {@link DEPENDENCY_FIELDS} must be deeply unchanged;
 *  - inside them, the set of dependency names must be unchanged — an addition or
 *    a removal is a supply-chain change, not a version update;
 *  - a constraint that moved must be a plain registry range on both sides.
 *
 * Returns `dependency-update` only when all three hold. `unreadable` covers a
 * manifest that was added, deleted, or cannot be parsed; `behavioural` covers
 * everything else. Both refuse the deploy — the cost of being wrong here is one
 * manual dispatch, and the cost of being wrong the other way is shipping an
 * unreviewed build step.
 *
 * @param {string|null} before file contents at the base revision, null if absent
 * @param {string|null} after  file contents at the head revision, null if absent
 */
export function inspectPackageJson(before, after) {
  if (before === null || after === null) {
    return { verdict: 'unreadable', reason: 'added, deleted, or unreadable at one end of the diff' }
  }

  let base
  let head
  try {
    base = JSON.parse(before)
    head = JSON.parse(after)
  } catch (error) {
    return { verdict: 'unreadable', reason: `not parseable as JSON (${error.message})` }
  }
  if (!isPlainObject(base) || !isPlainObject(head)) {
    return { verdict: 'unreadable', reason: 'not a JSON object' }
  }

  const outsideBase = withoutDependencyFields(base)
  const outsideHead = withoutDependencyFields(head)
  if (!isDeepStrictEqual(outsideBase, outsideHead)) {
    const names = [...new Set([...Object.keys(outsideBase), ...Object.keys(outsideHead)])]
      .filter((key) => !isDeepStrictEqual(outsideBase[key], outsideHead[key]))
      .sort()
    return {
      verdict: 'behavioural',
      reason: `changes outside the dependency fields: ${names.join(', ')}`,
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    const baseField = base[field] ?? {}
    const headField = head[field] ?? {}
    if (!isPlainObject(baseField) || !isPlainObject(headField)) {
      return { verdict: 'unreadable', reason: `${field} is not an object` }
    }

    const added = Object.keys(headField).filter((name) => !(name in baseField))
    const removed = Object.keys(baseField).filter((name) => !(name in headField))
    if (added.length > 0 || removed.length > 0) {
      const parts = []
      if (added.length > 0) parts.push(`added ${added.sort().join(', ')}`)
      if (removed.length > 0) parts.push(`removed ${removed.sort().join(', ')}`)
      return { verdict: 'behavioural', reason: `${field}: ${parts.join('; ')}` }
    }

    for (const [name, headRange] of Object.entries(headField)) {
      const baseRange = baseField[name]
      if (baseRange === headRange) continue
      if (typeof baseRange !== 'string' || typeof headRange !== 'string') {
        return { verdict: 'behavioural', reason: `${field}.${name} is not a version string` }
      }
      if (!REGISTRY_RANGE.test(baseRange) || !REGISTRY_RANGE.test(headRange)) {
        return {
          verdict: 'behavioural',
          reason: `${field}.${name} is not a plain registry range on both sides (${baseRange} -> ${headRange})`,
        }
      }
    }
  }

  return { verdict: 'dependency-update', reason: 'dependency versions only' }
}

/**
 * Route a list of repository-relative paths to the jobs that must run.
 *
 * Pure: no filesystem, no git, no environment. That is what makes
 * `scripts/detect-changes.test.mjs` able to assert the policy directly.
 *
 * The one thing paths alone cannot answer is whether a `package.json` diff is a
 * dependency bump, so `readManifest` is injected rather than opened here: the
 * command line below supplies a `git show` reader, and the tests supply literal
 * contents. Absent a reader, any `package.json` in the diff refuses the deploy
 * rather than assuming — a caller that cannot show the file cannot vouch for it.
 *
 * @param {string[]} files
 * @param {{ readManifest?: (path: string) => { before: string|null, after: string|null } }} [options]
 */
export function classify(files, options = {}) {
  const readManifest = options.readManifest ?? null
  const jobs = new Set()
  const categories = new Set()
  const unclassified = []
  let deps = false

  for (const file of files) {
    const path = file.trim()
    if (path === '') continue
    if (DEPENDENCY_MANIFESTS.some((manifest) => manifest.test(path))) deps = true
    const rule = RULES.find((candidate) => candidate.match.test(path))
    if (rule === undefined) {
      // Fail towards doing too much work. An unknown path is a rule this file
      // is missing, and the cost of guessing wrong in the other direction is a
      // green tick on something nobody tested.
      unclassified.push(path)
      categories.add('unclassified')
      deps = true
      for (const job of ALL) jobs.add(job)
      continue
    }
    categories.add(rule.category)
    for (const job of rule.jobs) jobs.add(job)
  }

  /*
   * Empty is NOT dependency-only. A push with no files reaching this function is
   * something unexpected — an empty commit, a merge whose diff resolved to
   * nothing, a caller that failed to produce a list — and answering "yes, deploy"
   * to a change nobody can see is the wrong direction to fail in.
   */
  const changed = files.map((file) => file.trim()).filter((file) => file !== '')
  const depsOnlyByPath =
    changed.length > 0 && changed.every((file) => DEPENDENCY_ONLY.some((manifest) => manifest.test(file)))

  /*
   * The second half of the gate: what the manifests actually say.
   *
   * Only reached when the paths already qualify, because reading a manifest that
   * arrived alongside a source file would answer a question nobody asked.
   */
  const depsOnlyRefusals = []
  if (depsOnlyByPath) {
    for (const path of changed.filter((file) => PACKAGE_JSON.test(file))) {
      if (readManifest === null) {
        depsOnlyRefusals.push(`${path}: no manifest reader, so the diff could not be inspected`)
        continue
      }
      const { before = null, after = null } = readManifest(path) ?? {}
      const { verdict, reason } = inspectPackageJson(before, after)
      if (verdict !== 'dependency-update') depsOnlyRefusals.push(`${path}: ${reason}`)
    }
  }
  const depsOnly = depsOnlyByPath && depsOnlyRefusals.length === 0

  return {
    depsOnly,
    depsOnlyRefusals,
    web: jobs.has('web'),
    numerical: jobs.has('numerical'),
    poster: jobs.has('poster'),
    e2e: jobs.has('e2e'),
    deps,
    categories: [...categories].sort(),
    unclassified,
  }
}

/** Everything on. Used for pushes to main, for `--all`, and whenever the diff cannot be trusted. */
export function everything(reason) {
  return {
    // `--all` means "we could not tell what changed", which is never a reason to
    // deploy on its own.
    depsOnly: false,
    depsOnlyRefusals: [`${reason}: the diff was not classified, so nothing vouches for it`],
    web: true,
    numerical: true,
    poster: true,
    e2e: true,
    deps: true,
    categories: [reason],
    unclassified: [],
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** `--base`/`--head`/`--files-from` take a value; `--all` does not. */
const VALUE_ARGUMENTS = { '--base': 'base', '--head': 'head', '--files-from': 'filesFrom' }

function parseArguments(argv) {
  const options = { base: null, head: null, filesFrom: null, all: false }
  let index = 0
  while (index < argv.length) {
    const argument = argv[index]
    if (argument === '--all') {
      options.all = true
      index += 1
      continue
    }
    const key = VALUE_ARGUMENTS[argument]
    if (key === undefined) {
      console.error(`unknown argument: ${argument}`)
      process.exit(2)
    }
    if (index + 1 >= argv.length) {
      console.error(`${argument} needs a value`)
      process.exit(2)
    }
    options[key] = argv[index + 1]
    index += 2
  }
  return options
}

function readFileList(source) {
  const text = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  return text.split('\n')
}

/**
 * The changed files between two commits.
 *
 * Three dots on purpose: `base...head` is "what head added since the two
 * diverged", which is the pull request. Two dots would also report everything
 * that landed on the base branch meanwhile and would run jobs for other
 * people's commits.
 *
 * Returns null when the range cannot be resolved — a shallow clone, or a base
 * commit that was never fetched — so the caller can fall back to running
 * everything instead of silently reporting an empty diff, which would skip
 * every job.
 */
function diffRange(base, head) {
  try {
    const output = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return output.split('\n')
  } catch (error) {
    console.error(`Could not diff ${base}...${head}: ${error.message}`)
    return null
  }
}

/**
 * One file's contents at a revision, or null when it is not there.
 *
 * Null is a legitimate answer — the manifest was added or deleted — and so is
 * null for a revision that cannot be resolved. Both refuse the deploy, which is
 * the direction to fail in.
 */
function showFile(revision, path) {
  try {
    return execFileSync('git', ['show', `${revision}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * Read both ends of a manifest diff.
 *
 * The base side is the MERGE BASE, not `base` itself, so that what is inspected
 * is the same three-dot range `diffRange` reported. Taking it from `base`
 * directly would compare against commits the change never saw, and a package.json
 * that main edited meanwhile would read as an unexplained behavioural change.
 */
function manifestReader(base, head) {
  let mergeBase = base
  try {
    mergeBase = execFileSync('git', ['merge-base', base, head], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Unrelated histories or a missing commit. `base` is the honest fallback,
    // and a manifest it cannot resolve reads as null, which refuses.
  }
  return (path) => ({ before: showFile(mergeBase, path), after: showFile(head, path) })
}

function main() {
  const options = parseArguments(process.argv.slice(2))

  let result
  let files = []
  if (options.all) {
    result = everything('forced')
  } else if (options.filesFrom !== null) {
    files = readFileList(options.filesFrom)
    // No revisions, so no manifest can be read: a package.json in the list is
    // reported as unvouched-for rather than assumed to be a version bump.
    result = classify(files)
  } else if (options.base !== null && options.head !== null) {
    const diff = diffRange(options.base, options.head)
    if (diff === null) {
      result = everything('diff-unavailable')
    } else {
      files = diff.filter((path) => path.trim() !== '')
      result = classify(files, { readManifest: manifestReader(options.base, options.head) })
    }
  } else {
    console.error('usage: detect-changes.mjs [--all | --base <sha> --head <sha> | --files-from <path|->]')
    process.exit(2)
  }

  /*
   * Whether the end-to-end suite exists in this tree at all.
   *
   * main does not carry it yet; the pull request that completes V1 adds it. The
   * e2e job is written once, here and in ci.yml, and turns itself on when the
   * files arrive — so merging that branch neither needs a workflow edit nor can
   * quietly leave the suite unrun.
   */
  const e2eSuitePresent = existsSync('apps/web/playwright.config.ts')

  const outputs = {
    web: String(result.web),
    numerical: String(result.numerical),
    poster: String(result.poster),
    e2e: String(result.e2e && e2eSuitePresent),
    e2e_suite_present: String(e2eSuitePresent),
    deps: String(result.deps),
    deps_only: String(result.depsOnly),
  }

  console.log(`changed files: ${files.length}`)
  for (const file of files.slice(0, 200)) console.log(`  ${file}`)
  if (files.length > 200) console.log(`  ... ${files.length - 200} more`)
  console.log('')
  console.log(`categories: ${result.categories.join(', ') || '(none)'}`)
  if (result.unclassified.length > 0) {
    console.log('')
    console.log('Paths that matched no rule — every job was enabled because of them.')
    console.log('Add a rule to scripts/detect-changes.mjs so the next change is routed properly:')
    for (const path of result.unclassified.slice(0, 50)) console.log(`  ${path}`)
  }
  if (result.depsOnlyRefusals.length > 0 && files.length > 0) {
    console.log('')
    console.log('Not eligible for an automatic deploy — a manifest in this diff says more than a version:')
    for (const refusal of result.depsOnlyRefusals) console.log(`  ${refusal}`)
  }
  console.log('')
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`)

  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `${Object.entries(outputs)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')}\n`,
    )
  }
}

// Only run the command line when invoked directly, so the test file can import
// `classify` without the argument parser exiting the process.
if (process.argv[1]?.endsWith('detect-changes.mjs')) main()
