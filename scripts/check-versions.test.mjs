#!/usr/bin/env node --test

/**
 * Tests for the version audit.
 *
 * Two halves, and both are load-bearing:
 *
 *  - the synthetic cases prove the checker actually *catches* a partial update, which is the only
 *    way to know the audit is worth running at all; and
 *  - the last tests run it against this repository, so `pnpm test` fails on a real drift rather
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
import {
  checkVersions,
  DESKTOP_VERSION_SITES,
  REFERENCE_VERSION_FILE,
  WEB_VERSION_SITES,
} from './check-versions.mjs'

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

/**
 * A consistent tree, from which each failing variant is derived.
 *
 * The two versions are deliberately unequal in the *passing* fixture: AAT Web 1.0.0 rendering AAT
 * 11.1.0's figure is the expected state, not a discrepancy, and a fixture that used one number for
 * both would let a checker that conflated the groups pass.
 */
function consistent(desktop = '11.1.0', web = '1.0.0') {
  return {
    [REFERENCE_VERSION_FILE]: `${desktop}\n`,
    'poster-renderer/src/poster_renderer/version.py': `DESKTOP_BASELINE_VERSION = "${desktop}"\nRENDERER_VERSION = "x"\n`,
    'apps/web/src/app/version.ts': `export const APP_VERSION = '${web}'\nexport const DESKTOP_BASELINE_VERSION = '${desktop}'\n`,
    'apps/web/worker/config.ts': `export const APP_VERSION = '${web}'\n`,
  }
}

test('a tree whose copies all agree has no problems', () => {
  const { desktopBaseline, webVersion, problems } = audit(consistent())
  assert.deepEqual(problems, [])
  assert.equal(desktopBaseline, '11.1.0')
  assert.equal(webVersion, '1.0.0')
})

test('the two version groups are independent — differing from each other is not a problem', () => {
  // The question this whole checker exists downstream of: "the figure says 11.1.0 but AAT Web is
  // 1.0.0". That is the designed state, and the audit must not try to reconcile it.
  assert.deepEqual(audit(consistent('11.1.0', '1.0.0')).problems, [])
  assert.deepEqual(audit(consistent('12.0.0', '2.3.1')).problems, [])
})

test('a trailing newline or stray whitespace in the reference file is tolerated', () => {
  const files = consistent()
  files[REFERENCE_VERSION_FILE] = '  11.1.0  \n\n'
  assert.deepEqual(audit(files).problems, [])
})

test('a half-finished desktop bump is caught, and the message names the file and both versions', () => {
  // The real failure mode: the desktop released 11.2.0, the reference tree and the about line were
  // updated, and the watermark constant was not.
  const files = consistent('11.2.0')
  files['poster-renderer/src/poster_renderer/version.py'] = 'DESKTOP_BASELINE_VERSION = "11.1.0"\n'

  const { problems } = audit(files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /poster-renderer\/src\/poster_renderer\/version\.py/)
  assert.match(problems[0], /says 11\.1\.0/)
  assert.match(problems[0], /says 11\.2\.0/)
  // The consequence, not just the discrepancy.
  assert.match(problems[0], /watermark/)
})

test("a drifted Worker fallback is caught, because it decides a stored snapshot's provenance", () => {
  const files = consistent('11.1.0', '1.1.0')
  files['apps/web/worker/config.ts'] = "export const APP_VERSION = '1.0.0'\n"

  const { problems } = audit(files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /apps\/web\/worker\/config\.ts/)
  assert.match(problems[0], /says 1\.0\.0/)
  assert.match(problems[0], /says 1\.1\.0/)
})

test('every restating file is checked, not just the first', () => {
  for (const site of DESKTOP_VERSION_SITES) {
    const files = consistent()
    files[site.file] = files[site.file].replace(/11\.1\.0/, '9.9.9')
    const { problems } = audit(files)
    assert.equal(problems.length, 1, `${site.file} was not audited for the desktop baseline`)
  }
  // The first web site is the reference, so drifting it is reported against the *other* file.
  for (const site of WEB_VERSION_SITES.slice(1)) {
    const files = consistent()
    files[site.file] = files[site.file].replace(/1\.0\.0/, '9.9.9')
    const { problems } = audit(files)
    assert.equal(problems.length, 1, `${site.file} was not audited for the web version`)
  }
})

test('a file that stops declaring a version fails as a missing declaration, not as agreement', () => {
  // The trap a looser checker falls into: deleting the constant makes "no mismatch" true.
  const files = consistent()
  files['poster-renderer/src/poster_renderer/version.py'] = '# the constant moved somewhere else\n'
  const { problems } = audit(files)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /no longer declares/)

  const noWeb = consistent()
  noWeb['apps/web/worker/config.ts'] = '// no version here any more\n'
  const webProblems = audit(noWeb).problems
  assert.equal(webProblems.length, 1)
  assert.match(webProblems[0], /no longer declares the AAT Web version/)
})

test('a missing or malformed reference file is reported, and does not stop the web check', () => {
  const files = consistent()
  delete files[REFERENCE_VERSION_FILE]
  const missing = audit(files)
  assert.equal(missing.desktopBaseline, null)
  assert.match(missing.problems[0], /is missing/)
  // The second group still ran: one broken source of truth must not silence the other audit.
  assert.equal(missing.webVersion, '1.0.0')

  const malformedFiles = consistent()
  malformedFiles[REFERENCE_VERSION_FILE] = 'v11.1\n'
  const malformed = audit(malformedFiles)
  assert.equal(malformed.desktopBaseline, null)
  assert.match(malformed.problems[0], /MAJOR\.MINOR\.PATCH/)
})

test('this repository agrees with itself', () => {
  const { problems } = checkVersions()
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('this repository really does carry two different numbers', () => {
  // Guards the fixture above from becoming vacuous: if AAT Web ever happened to be versioned
  // 11.1.0 too, the independence test would stop testing anything.
  const { desktopBaseline, webVersion } = checkVersions()
  assert.ok(desktopBaseline)
  assert.ok(webVersion)
  assert.notEqual(desktopBaseline, webVersion)
})
