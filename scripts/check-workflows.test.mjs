#!/usr/bin/env node --test

/**
 * Tests for the workflow policy checker.
 *
 * Written against synthetic workflows rather than against `.github/workflows/*`,
 * so the rules stay asserted even when the real workflows change — and so the
 * failing cases can be written down at all, which is the only way to know the
 * checker would actually catch them.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkWorkflow } from './check-workflows.mjs'

/** A minimal compliant workflow, used as the base for each failing variant. */
const GOOD = `name: Example

on:
  pull_request:

permissions: {}

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - name: Build
        env:
          BASE: \${{ github.event.pull_request.base.sha }}
        run: |
          echo "building $BASE"
`

function problems(text, name = 'example.yml') {
  return checkWorkflow(name, text)
}

test('a compliant workflow reports nothing', () => {
  assert.deepEqual(problems(GOOD), [])
})

// ---------------------------------------------------------------------------
// The rule this file was written for
// ---------------------------------------------------------------------------

test('duplicate job keys are reported — YAML would take the last one silently', () => {
  const text = GOOD.replace(
    '  build:\n',
    `  build:
    name: First
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Something
        run: echo hi

  build:
`,
  )
  const found = problems(text)
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /duplicate job `build`/)
  assert.match(found[0], /LAST definition/)
})

test('the real merge trap: two e2e jobs differing in what they run', () => {
  // Reduced from the actual conflict — both sides added an `e2e:` job and git
  // merged them as siblings. Only the second survives, and it was chance which.
  const text = `name: CI

on:
  pull_request:

permissions: {}

jobs:
  e2e:
    name: End-to-end (Playwright)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Run E2E suite
        run: pnpm exec playwright test

  numerical:
    name: Numerical
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    steps:
      - name: Check
        run: python3 generate_golden.py --check

  e2e:
    name: End-to-end (Playwright)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
    steps:
      - name: Build the poster renderer image
        run: docker build -t aat-poster-renderer:ci poster-renderer

      - name: Run E2E suite
        run: pnpm exec playwright test
`
  const found = problems(text, 'ci.yml')
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /duplicate job `e2e`/)
})

test('distinct job names are not confused with duplicates', () => {
  const text = GOOD.replace(
    '  build:\n',
    `  lint:
    name: Lint
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Lint
        run: pnpm lint

  build:
`,
  )
  assert.deepEqual(problems(text), [])
})

// ---------------------------------------------------------------------------
// Permissions and timeouts
// ---------------------------------------------------------------------------

test('a missing top-level permissions block is reported', () => {
  const found = problems(GOOD.replace('permissions: {}\n\n', ''))
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /no top-level `permissions:`/)
})

test('a job without permissions is reported', () => {
  const found = problems(GOOD.replace('    permissions:\n      contents: read\n', ''))
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /job `build` declares no `permissions:`/)
})

test('a job without a timeout is reported', () => {
  const found = problems(GOOD.replace('    timeout-minutes: 10\n', ''))
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /declares no `timeout-minutes:`/)
})

// ---------------------------------------------------------------------------
// Action pinning
// ---------------------------------------------------------------------------

test('a tag-referenced action is reported', () => {
  const found = problems(
    GOOD.replace('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1', 'actions/checkout@v7'),
  )
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /not pinned to a full commit SHA/)
})

test('a short SHA is not a pin', () => {
  const found = problems(GOOD.replace('3d3c42e5aac5ba805825da76410c181273ba90b1', '3d3c42e'))
  assert.match(found[0], /not pinned to a full commit SHA/)
})

test('checkout without persist-credentials: false is reported', () => {
  const found = problems(GOOD.replace('        with:\n          persist-credentials: false\n', ''))
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /persist-credentials: false/)
})

// ---------------------------------------------------------------------------
// Expression injection
// ---------------------------------------------------------------------------

test('event data interpolated into a run body is reported', () => {
  const found = problems(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template literal
    GOOD.replace('echo "building $BASE"', 'echo "${{ github.event.pull_request.title }}"'),
  )
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /interpolated into a `run:` body/)
})

test('github.head_ref in a run body is reported', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template literal
  const found = problems(GOOD.replace('echo "building $BASE"', 'git switch "${{ github.head_ref }}"'))
  assert.match(found[0], /interpolated into a `run:` body/)
})

test('the same expression inside env: is fine — that is the prescribed fix', () => {
  assert.deepEqual(problems(GOOD), [])
})

test('an expression in an if: condition is not a shell body', () => {
  const text = GOOD.replace(
    '      - name: Build\n',
    '      - name: Build\n        if: github.event.pull_request.draft == false\n',
  )
  assert.deepEqual(problems(text), [])
})

test('a multi-line run block is scanned, not just its first line', () => {
  const found = problems(
    GOOD.replace(
      '        run: |\n          echo "building $BASE"\n',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax, not a JS template literal
      '        run: |\n          set -e\n          echo ok\n          echo "${{ github.event.head_commit.message }}"\n',
    ),
  )
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /interpolated into a `run:` body/)
})

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

test('pull_request_target is forbidden outright', () => {
  const found = problems(GOOD.replace('  pull_request:\n', '  pull_request_target:\n'))
  assert.equal(found.length, 1, found.join('\n'))
  assert.match(found[0], /`pull_request_target` is forbidden/)
})

// ---------------------------------------------------------------------------
// Refusing to pass on something it did not understand
// ---------------------------------------------------------------------------

test('a file with no jobs block fails rather than passing vacuously', () => {
  const found = problems('name: Nope\non:\n  push:\n')
  assert.equal(found.length, 1)
  assert.match(found[0], /does not look like a workflow/)
})

test('a jobs block with no recognisable job keys fails rather than passing', () => {
  const found = problems('permissions: {}\njobs:\n  # nothing here yet\n')
  assert.equal(found.length, 1)
  assert.match(found[0], /no job keys were found/)
})

// ---------------------------------------------------------------------------
// The workflows this repository actually ships
// ---------------------------------------------------------------------------

test('every committed workflow satisfies the policy', () => {
  const directory = '.github/workflows'
  const files = readdirSync(directory).filter((entry) => entry.endsWith('.yml'))
  assert.ok(files.length >= 3, `expected ci.yml, security.yml and deploy.yml; found ${files.join(', ')}`)
  const found = files.flatMap((file) =>
    checkWorkflow(join(directory, file), readFileSync(join(directory, file), 'utf8')),
  )
  assert.deepEqual(found, [])
})
