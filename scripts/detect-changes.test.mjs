#!/usr/bin/env node --test

/**
 * The change detector's own tests.
 *
 * A wrong rule here does not fail loudly. It produces a green pull request for
 * a job that never ran, which is the one CI failure mode nobody notices — so
 * the policy is asserted directly rather than inferred from a workflow run.
 *
 * Run with `node --test scripts` (which is what `pnpm test` does at the root).
 * Deliberately no test framework: this file has to keep working when the
 * lockfile is the thing under change.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classify, everything, JOBS, RULES } from './detect-changes.mjs'

/** Assert the exact set of jobs a change turns on — including the ones it must not. */
function expectJobs(files, expected) {
  const result = classify(files)
  const actual = JOBS.filter((job) => result[job])
  assert.deepEqual(
    actual,
    JOBS.filter((job) => expected.includes(job)),
    `${JSON.stringify(files)}\n  categories: ${result.categories.join(', ')}\n  unclassified: ${result.unclassified.join(', ')}`,
  )
  return result
}

test('no change runs nothing', () => {
  expectJobs([], [])
  expectJobs(['', '  '], [])
})

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

test('docs-only changes run no job', () => {
  const result = expectJobs(
    ['docs/web-architecture.md', 'docs/supply-chain.md', 'README.md', 'CLAUDE.md', 'AGENTS.md'],
    [],
  )
  assert.deepEqual(result.categories, ['docs'])
  assert.deepEqual(result.unclassified, [])
})

test('a README inside a code directory is still prose', () => {
  expectJobs(['poster-renderer/README.md', 'apps/web/src/README.md'], [])
})

test('agent tooling is not part of the build', () => {
  expectJobs(['.claude/settings.json', '.claude/hooks/session-start.sh'], [])
})

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

test('a Web UI change runs the web job and the browser suite', () => {
  expectJobs(['apps/web/src/screens/RunsScreen.tsx'], ['web', 'e2e'])
  expectJobs(['apps/web/src/styles/app.css'], ['web', 'e2e'])
  expectJobs(['apps/web/index.html', 'apps/web/public/robots.txt'], ['web', 'e2e'])
})

test('a Worker route change runs the web job and the browser suite', () => {
  expectJobs(['apps/web/worker/routes/runs.ts'], ['web', 'e2e'])
  expectJobs(['apps/web/worker/middleware/authorize.ts'], ['web', 'e2e'])
  expectJobs(['apps/web/worker/auth/passkey-plugin.ts'], ['web', 'e2e'])
})

test('a D1 migration runs the workerd suite and the real-database E2E stack', () => {
  expectJobs(['apps/web/migrations/0004_something.sql'], ['web', 'e2e'])
  expectJobs(['apps/web/migrations/meta/_journal.json'], ['web', 'e2e'])
  expectJobs(['apps/web/drizzle.config.ts'], ['web', 'e2e'])
})

test('the Node/DOM/workerd suites do not drag in Playwright', () => {
  expectJobs(['apps/web/test/ui/run-gallery.test.ts'], ['web'])
  expectJobs(['apps/web/test/dom/sign-in.test.tsx'], ['web'])
  expectJobs(['apps/web/test/worker/runs.spec.ts'], ['web'])
  expectJobs(['apps/web/vitest.config.ts'], ['web'])
  expectJobs(['apps/web/vitest.dom.config.ts'], ['web'])
  expectJobs(['apps/web/test/worker/vitest.config.ts'], ['web'])
})

test('shared CSV fixtures reach the browser too', () => {
  expectJobs(['apps/web/test/fixtures/e2e/260811a_data.csv'], ['web', 'e2e'])
})

test('the Pages front door reaches the web job and the browser suite', () => {
  // The Function every authenticated request passes through. `pnpm typecheck`
  // in apps/web now covers it, and the E2E suite is the only thing that
  // exercises the Pages -> service-binding hop at all.
  const result = expectJobs(['apps/web/pages/functions/api/[[path]].ts'], ['web', 'e2e'])
  assert.deepEqual(result.categories, ['pages-front-door'])
  expectJobs(['apps/web/pages/tsconfig.json'], ['web', 'e2e'])
})

test('the Pages routing table is part of the deployed output', () => {
  // _routes.json is what replaces run_worker_first. Getting it wrong returns
  // index.html at 200 for every API call.
  expectJobs(['apps/web/public/_routes.json'], ['web', 'e2e'])
})

test('the E2E suite and its config run only the E2E job', () => {
  expectJobs(['apps/web/playwright.config.ts'], ['e2e'])
  expectJobs(['apps/web/e2e/specs/passkey.spec.ts'], ['e2e'])
  expectJobs(['apps/web/e2e/harness/stack.ts'], ['e2e'])
  expectJobs(['apps/web/e2e/wrangler.e2e.jsonc'], ['e2e'])
})

test('deployment shape changes run the web job and the browser suite', () => {
  expectJobs(['apps/web/wrangler.jsonc'], ['web', 'e2e'])
  expectJobs(['apps/web/vite.config.ts'], ['web', 'e2e'])
  expectJobs(['apps/web/tsconfig.json'], ['web', 'e2e'])
  expectJobs(['apps/web/package.json'], ['web', 'e2e'])
  expectJobs(['apps/web/scripts/resolve-wrangler-config.mjs'], ['web', 'e2e'])
})

test('an unrecognised file under apps/web still runs the app jobs', () => {
  const result = expectJobs(['apps/web/some-new-thing.ts'], ['web', 'e2e'])
  assert.deepEqual(result.categories, ['web-other'])
})

// ---------------------------------------------------------------------------
// Workspace packages
// ---------------------------------------------------------------------------

test('analysis-core is checked against the Python oracle', () => {
  expectJobs(['packages/analysis-core/src/numeric.ts'], ['web', 'numerical', 'e2e'])
  expectJobs(['packages/analysis-core/test/pipeline.golden.test.ts'], ['web', 'numerical', 'e2e'])
})

test('plot-spec is half of the poster visual contract', () => {
  expectJobs(['packages/plot-spec/src/presets.ts'], ['web', 'poster', 'e2e'])
  expectJobs(['packages/plot-spec/src/builder.ts'], ['web', 'poster', 'e2e'])
})

test('shared runs the application jobs', () => {
  expectJobs(['packages/shared/src/snapshot.ts'], ['web', 'e2e'])
})

test('a workspace package with no rule runs everything', () => {
  const result = expectJobs(['packages/brand-new/src/index.ts'], JOBS)
  assert.deepEqual(result.categories, ['packages-other'])
})

// ---------------------------------------------------------------------------
// The numerical oracle
// ---------------------------------------------------------------------------

test('the Python reference runs the golden job and nothing else', () => {
  expectJobs(['reference/python/core/data_processor.py'], ['numerical'])
  expectJobs(['reference/python/generate_golden.py'], ['numerical'])
  expectJobs(['reference/python/requirements.txt'], ['numerical'])
})

test('a golden fixture is compared from both sides', () => {
  expectJobs(['tests/golden/index.json'], ['web', 'numerical'])
  expectJobs(['tests/golden/arrays/abc.f64'], ['web', 'numerical'])
})

test('a CSV fixture is read by all three consumers', () => {
  expectJobs(['tests/fixtures/csv/realistic_large.csv'], ['web', 'numerical', 'e2e'])
})

// ---------------------------------------------------------------------------
// The poster renderer
// ---------------------------------------------------------------------------

test('the poster renderer runs its own job and the integration that drives it', () => {
  expectJobs(['poster-renderer/src/poster_renderer/render.py'], ['poster', 'e2e'])
  expectJobs(['poster-renderer/tests/test_visual_contract.py'], ['poster', 'e2e'])
  expectJobs(['poster-renderer/src/poster_renderer/preset.py'], ['poster', 'e2e'])
})

test('the Dockerfile and the pinned wheels are the image the E2E stack starts', () => {
  expectJobs(['poster-renderer/Dockerfile'], ['poster', 'e2e'])
  expectJobs(['poster-renderer/requirements.txt'], ['poster', 'e2e'])
})

// ---------------------------------------------------------------------------
// Root configuration and dependencies
// ---------------------------------------------------------------------------

test('the root package.json defines every CI script, so it runs everything', () => {
  expectJobs(['package.json'], JOBS)
})

test('the npm lockfile cannot move a Python wheel', () => {
  // The weekly Renovate lockFileMaintenance pull request. It used to install
  // NumPy and build a container image to prove a JavaScript dependency bump.
  const result = expectJobs(['pnpm-lock.yaml'], ['web', 'e2e'])
  assert.deepEqual(result.categories, ['npm-lockfile'])
})

test('the workspace manifest holds the supply-chain gates', () => {
  expectJobs(['pnpm-workspace.yaml'], ['web', 'e2e'])
})

test('TypeScript and formatter configuration', () => {
  expectJobs(['tsconfig.base.json'], ['web', 'e2e'])
  expectJobs(['biome.json'], ['web'])
})

// ---------------------------------------------------------------------------
// CI configuration
// ---------------------------------------------------------------------------

test('a workflow change runs the whole matrix', () => {
  expectJobs(['.github/workflows/ci.yml'], JOBS)
  expectJobs(['.github/workflows/security.yml'], JOBS)
})

test('the deploy workflow runs the whole matrix', () => {
  // deploy.yml re-runs verification itself, but a change to it is a change to
  // what "verified" means, and this is the cheap place to notice.
  expectJobs(['.github/workflows/deploy.yml'], JOBS)
})

test('the scripts CI depends on run the whole matrix, including this detector', () => {
  expectJobs(['scripts/detect-changes.mjs'], JOBS)
  expectJobs(['scripts/detect-changes.test.mjs'], JOBS)
  expectJobs(['scripts/check-worker-bundle-size.mjs'], JOBS)
  expectJobs(['scripts/check-commit-identity.mjs'], JOBS)
  expectJobs(['.githooks/pre-commit'], JOBS)
  expectJobs(['renovate.json5'], JOBS)
  expectJobs(['.gitleaks.toml'], JOBS)
})

// ---------------------------------------------------------------------------
// The safety net
// ---------------------------------------------------------------------------

test('a path no rule matches turns everything on and says so', () => {
  const result = expectJobs(['some/unknown/place.ts'], JOBS)
  assert.deepEqual(result.unclassified, ['some/unknown/place.ts'])
  assert.ok(result.categories.includes('unclassified'))
})

test('repository metadata is deliberately unclassified rather than assumed harmless', () => {
  // .gitignore reaches biome (`useIgnoreFile`) and every glob in the repository.
  // Guessing "harmless" here would be guessing about a file whose entire job is
  // to change which files other tools see.
  expectJobs(['.gitignore'], JOBS)
})

test('a mixed change is the union, never the first match', () => {
  expectJobs(['docs/deployment.md', 'apps/web/src/app/App.tsx'], ['web', 'e2e'])
  expectJobs(['reference/python/fixtures.py', 'poster-renderer/Dockerfile'], ['numerical', 'poster', 'e2e'])
  expectJobs(
    ['docs/x.md', 'packages/analysis-core/src/numeric.ts', 'poster-renderer/src/poster_renderer/render.py'],
    JOBS,
  )
})

test('everything() is on for every job', () => {
  const result = everything('push-to-main')
  for (const job of JOBS) assert.equal(result[job], true, job)
  assert.equal(result.deps, true)
  assert.deepEqual(result.categories, ['push-to-main'])
})

// ---------------------------------------------------------------------------
// The dependency-manifest flag, consumed by .github/workflows/security.yml
// ---------------------------------------------------------------------------

test('every dependency manifest sets deps, across both ecosystems', () => {
  for (const path of [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'apps/web/package.json',
    'packages/shared/package.json',
    'reference/python/requirements.txt',
    'reference/python/requirements.in',
    'poster-renderer/requirements.txt',
    'poster-renderer/Dockerfile',
    'osv-scanner.toml',
  ]) {
    assert.equal(classify([path]).deps, true, path)
  }
})

test('ordinary source and prose do not set deps', () => {
  for (const path of [
    'apps/web/src/app/App.tsx',
    'apps/web/worker/routes/runs.ts',
    'packages/analysis-core/src/numeric.ts',
    'poster-renderer/src/poster_renderer/render.py',
    'docs/supply-chain.md',
  ]) {
    assert.equal(classify([path]).deps, false, path)
  }
})

test('editing the scanner pins re-runs the scan they configure', () => {
  for (const path of ['.github/workflows/security.yml', 'scripts/detect-changes.mjs']) {
    assert.equal(classify([path]).deps, true, path)
  }
})

test('an unclassified path sets deps too — a scan that did not run found nothing', () => {
  assert.equal(classify(['some/unknown/place.ts']).deps, true)
})

// ---------------------------------------------------------------------------
// The rule table itself
// ---------------------------------------------------------------------------

test('every rule names only real jobs', () => {
  for (const rule of RULES) {
    assert.ok(rule.category.length > 0)
    assert.ok(rule.match instanceof RegExp, rule.category)
    for (const job of rule.jobs) assert.ok(JOBS.includes(job), `${rule.category} -> unknown job ${job}`)
  }
})

test('no rule is shadowed by an earlier one that routes differently', () => {
  // First match wins, so an ordering mistake silently changes the policy. This
  // catches the case where a broad rule is moved above a narrow one.
  const samples = [
    'apps/web/e2e/specs/passkey.spec.ts',
    'apps/web/test/dom/sign-in.test.tsx',
    'apps/web/src/main.tsx',
    'packages/plot-spec/src/presets.ts',
    'packages/analysis-core/src/numeric.ts',
    'poster-renderer/Dockerfile',
    'docs/deployment.md',
    'package.json',
    'pnpm-lock.yaml',
  ]
  const expected = {
    'apps/web/e2e/specs/passkey.spec.ts': 'e2e-suite',
    'apps/web/test/dom/sign-in.test.tsx': 'web-tests',
    'apps/web/src/main.tsx': 'web-ui',
    'packages/plot-spec/src/presets.ts': 'plot-spec',
    'packages/analysis-core/src/numeric.ts': 'analysis-core',
    'poster-renderer/Dockerfile': 'poster-renderer',
    'docs/deployment.md': 'docs',
    'package.json': 'root-config',
    'pnpm-lock.yaml': 'npm-lockfile',
  }
  for (const path of samples) {
    assert.deepEqual(classify([path]).categories, [expected[path]], path)
  }
})
