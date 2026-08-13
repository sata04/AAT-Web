#!/usr/bin/env node

/**
 * Prove the secret scanner still detects secrets.
 *
 * A scanner that has stopped working does not announce it. A broken download, a
 * configuration file that silences one rule too many, an allowlist that grew a
 * `.*` — every one of those produces "no leaks found", exit 0, a green tick, and
 * a security control that has quietly been off for months. The only way to tell
 * that outcome apart from a clean repository is to hand the scanner something it
 * is *required* to find and fail when it does not.
 *
 * So this writes a synthetic credential to a temporary directory outside the
 * repository, scans that directory, and fails unless the scanner reports it.
 *
 * ## Why the fixture is generated rather than committed
 *
 * Three reasons, all of them about not creating the problem this is meant to
 * detect:
 *
 *  - a committed file containing a credential-shaped string is a permanent
 *    finding in every full-history scan, and the usual fix — an allowlist for
 *    the path — is the exact hole the canary exists to catch;
 *  - GitHub push protection refuses pushes containing recognised credential
 *    formats, so a committed fixture would block the push that added it;
 *  - the value is assembled from fragments below, so this source file does not
 *    itself contain the pattern and neither the scanner nor push protection has
 *    anything to react to.
 *
 * The value is synthetic and grants nothing: `AKIA…` is AWS's access-key-id
 * *shape*, and this one spells out what it is. Never put a working credential
 * here — a canary is not a place to test whether revocation worked.
 *
 * Usage: node scripts/scanner-canary.mjs <path-to-gitleaks>
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The synthetic findings the scanner has to produce, and the gitleaks rule that
 * has to produce each one.
 *
 * Two rules rather than one, because they fail independently: `aws-access-token`
 * is a fixed pattern, `generic-api-key` is keyword-plus-entropy. A regression
 * that disables pattern rules and a regression that disables entropy scoring
 * are different regressions, and a canary that only covers one would pass
 * through the other.
 */
export const CANARIES = [
  {
    rule: 'aws-access-token',
    file: 'aws.txt',
    // Assembled so this file contains no complete key-shaped string.
    build: () => `aws_access_key_id = ${['AKI', 'A', 'CANARY', 'EXAMPLE', 'KEY'].join('')}\n`,
  },
  {
    rule: 'generic-api-key',
    file: 'generic.txt',
    // Keyword plus enough entropy to clear the rule's 3.5 threshold. Dictionary
    // words and separators drag the score down and hit gitleaks' stopword list,
    // which is why this is a run of mixed-case alphanumerics rather than
    // something more obviously labelled.
    build: () => `api_key = "${['canary', '8Xq2Vt7Zm', '4Nb9Pw1Ry', '6Kd3Fs0Lh'].join('')}"\n`,
  },
]

/** Write the fixture into a fresh temporary directory and return its path. */
export function writeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aat-scanner-canary-'))
  for (const canary of CANARIES) writeFileSync(join(directory, canary.file), canary.build())
  return directory
}

function main() {
  const gitleaks = process.argv[2]
  if (!gitleaks) {
    console.error('usage: scanner-canary.mjs <path-to-gitleaks>')
    process.exit(2)
  }

  const directory = writeFixture()
  const report = join(directory, 'report.json')

  /*
   * Scanned with the default rule set, NOT this repository's .gitleaks.toml.
   *
   * The repository config exists to silence known-synthetic values, and running
   * the canary through it would let a future over-broad allowlist silence the
   * canary as well — leaving the check green precisely when it has stopped
   * meaning anything. What is under test here is the scanner, not the policy.
   */
  let exitCode = 0
  try {
    execFileSync(
      gitleaks,
      ['dir', directory, '--no-banner', '--redact', '--report-format', 'json', '--report-path', report],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
  } catch (error) {
    exitCode = error.status ?? -1
  }

  let findings = []
  try {
    findings = JSON.parse(readFileSync(report, 'utf8')) ?? []
  } catch (error) {
    console.error(`Canary: the scanner wrote no readable report (${error.message}).`)
    process.exit(1)
  }

  const found = new Set(findings.map((finding) => finding.RuleID))
  const missing = CANARIES.filter((canary) => !found.has(canary.rule)).map((canary) => canary.rule)

  if (missing.length > 0 || exitCode !== 1) {
    console.error('')
    console.error('CANARY FAILED — the secret scanner did not report a secret that was placed for it.')
    console.error(`  expected rules : ${CANARIES.map((canary) => canary.rule).join(', ')}`)
    console.error(`  reported rules : ${[...found].join(', ') || '(none)'}`)
    console.error(`  exit code      : ${exitCode} (expected 1, "leaks found")`)
    console.error('')
    console.error('Do not treat the scan that follows as evidence of anything. Something has')
    console.error('broken in the scanner itself, its download, or its rule set.')
    process.exit(1)
  }

  console.log(`Canary passed: ${[...found].sort().join(', ')} reported as expected.`)
}

if (process.argv[1]?.endsWith('scanner-canary.mjs')) main()
