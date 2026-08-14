#!/usr/bin/env node --test

/**
 * Tests for the desktop-baseline version audit.
 *
 * Two halves, and both are load-bearing:
 *
 *  - the synthetic cases prove the checker actually *catches* a partial update, which is the only
 *    way to know the audit is worth running at all; and
 *  - the last test runs it against this repository, so `pnpm test` fails on a real drift rather
 *    than merely proving that a checker exists.
 *
 * Deliberately no test framework, for the reason `detect-changes.test.mjs` gives: this file has to
 * keep working when the lockfile is the thing under change.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { checkVersions, DESKTOP_VERSION_SITES, REFERENCE_VERSION_FILE } from './check-versions.mjs'

/** Build a throwaway tree containing `files`, run the audit over it, and clean up. */
function audit(files) {
  const root = mkdtempSync(join(tmpdir(), 'aat-versions-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), contents)
    }
    return checkVersions(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** A consistent tree at `version`, from which each failing variant is derived. */
function consistent(version) {
  return {
    [REFERENCE_VERSION_FILE]: `${version}\n`,
    'poster-renderer/src/poster_renderer/version.py': `APP_VERSION = "${version}"\nRENDERER_VERSION = "x"\n`,
    'apps/web/src/app/version.ts': `export const DESKTOP_BASELINE_VERSION = '${version}'\n`,
  }
}

test('a tree whose copies all agree has no problems', () => {
  const { version, problems } = audit(consistent('11.1.0'))
  assert.deepEqual(problems, [])
  assert.equal(version, '11.1.0')
})

test('a trailing newline or stray whitespace in the reference file is tolerated', () => {
  const files = consistent('11.1.0')
  files[REFERENCE_VERSION_FILE] = '  11.1.0  \n\n'
  assert.deepEqual(audit(files).problems, [])
})

test('a half-finished bump is caught, and the message names the file and the two versions', () => {
  // The real failure mode: the desktop released 11.2.0, the reference tree and the about line were
  // updated, and the watermark constant was not.
  const files = consistent('11.2.0')
  files['poster-renderer/src/poster_renderer/version.py'] = 'APP_VERSION = "11.1.0"\n'

  const { problems } = audit(files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /poster-renderer\/src\/poster_renderer\/version\.py/)
  assert.match(problems[0], /says 11\.1\.0/)
  assert.match(problems[0], /says 11\.2\.0/)
  // The consequence, not just the discrepancy.
  assert.match(problems[0], /watermark/)
})

test('every restating file is checked, not just the first', () => {
  for (const site of DESKTOP_VERSION_SITES) {
    const files = consistent('11.1.0')
    files[site.file] = files[site.file].replace('11.1.0', '9.9.9')
    const { problems } = audit(files)
    assert.equal(problems.length, 1, `${site.file} was not audited`)
    assert.match(problems[0], new RegExp(site.file.replaceAll('/', '\\/').replaceAll('.', '\\.')))
  }
})

test('a file that stops declaring the version fails as a missing declaration, not as agreement', () => {
  // The trap a looser checker falls into: deleting the constant makes "no mismatch" true.
  const files = consistent('11.1.0')
  files['poster-renderer/src/poster_renderer/version.py'] = '# the constant moved somewhere else\n'
  const { problems } = audit(files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no longer declares/)
})

test('a missing or malformed reference file is reported instead of being skipped', () => {
  const missing = audit({
    'apps/web/src/app/version.ts': "export const DESKTOP_BASELINE_VERSION = '1.0.0'\n",
  })
  assert.equal(missing.version, null)
  assert.match(missing.problems[0], /is missing/)

  const files = consistent('11.1.0')
  files[REFERENCE_VERSION_FILE] = 'v11.1\n'
  const malformed = audit(files)
  assert.equal(malformed.version, null)
  assert.match(malformed.problems[0], /MAJOR\.MINOR\.PATCH/)
})

test('this repository agrees with itself', () => {
  const { problems } = checkVersions()
  assert.deepEqual(problems, [], problems.join('\n'))
})
