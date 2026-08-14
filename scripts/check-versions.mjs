#!/usr/bin/env node

/**
 * The desktop-baseline version audit.
 *
 * AAT Web restates the desktop application's release version in several places, and one of those
 * places is **drawn into every poster figure**: `poster-renderer` stamps `AAT v11.1.0` into the
 * corner of the PNG. That string is a provenance claim on a research figure — it says which AAT
 * release's export path the figure reproduces — and nothing in the repository used to check it.
 * If the desktop shipped 11.2.0 and only some of the copies were updated, posters would keep
 * claiming a version that had stopped being the one they track, and no test would notice, because
 * every one of those copies is a plausible string on its own.
 *
 * So the version is *vendored as data*, next to the commit the reference tree was taken from:
 *
 *   reference/python/REFERENCE_COMMIT.txt   which AAT commit `reference/python/core/**` is a copy of
 *   reference/python/REFERENCE_VERSION.txt  the `project.version` of AAT at that commit
 *
 * and every other copy is checked against it. Updating the vendored reference means updating one
 * file and then being told, by name, which other files disagree.
 *
 * Deliberately *not* a build-time define. The renderer is a container that must not read a sibling
 * repository, `apps/web/src/app/version.ts` explains why these constants are reviewed by a human
 * rather than generated, and — decisively — moving the watermark version changes the pixels of
 * every future poster (see `docs/versioning.md`). A value with that consequence should be a diff
 * someone approved, not a number that appears during a build. This checker's job is only to make
 * a *partial* update impossible.
 *
 * Run with `pnpm test` (via `scripts/check-versions.test.mjs`) or directly:
 *   node scripts/check-versions.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Where the one true desktop-baseline version lives. */
export const REFERENCE_VERSION_FILE = 'reference/python/REFERENCE_VERSION.txt'

const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * Every place the desktop baseline is restated, and how to find it in that file.
 *
 * Each pattern captures the version in group 1 and is anchored to the surrounding syntax, so a
 * file that stops declaring the constant at all fails as "no match" rather than passing silently
 * — the failure mode a looser `/\d+\.\d+\.\d+/` would have.
 *
 * `note` is printed with a mismatch, because "these two numbers differ" is not actionable on its
 * own: what a reader needs to decide is whether updating this particular copy is a formality or a
 * visual-contract change.
 */
export const DESKTOP_VERSION_SITES = [
  {
    file: 'poster-renderer/src/poster_renderer/version.py',
    pattern: /^APP_VERSION = "(.+?)"$/m,
    note: 'drawn into the poster watermark — moving it changes the pixels of every future figure',
  },
  {
    file: 'apps/web/src/app/version.ts',
    pattern: /^export const DESKTOP_BASELINE_VERSION = '(.+?)'$/m,
    note: 'shown in the about/provenance line',
  },
]

function read(root, file) {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return null
  }
}

/**
 * Audit the repository at `root`. Returns `{ version, problems }`; `problems` is empty when every
 * copy agrees. Never throws for a content problem — the caller decides how to report.
 */
export function checkVersions(root = REPO_ROOT) {
  const problems = []

  const raw = read(root, REFERENCE_VERSION_FILE)
  if (raw === null) {
    problems.push(`${REFERENCE_VERSION_FILE} is missing; it is the source of truth for the desktop baseline.`)
    return { version: null, problems }
  }

  const version = raw.trim()
  if (!SEMVER.test(version)) {
    problems.push(
      `${REFERENCE_VERSION_FILE} must contain a bare MAJOR.MINOR.PATCH version, got "${version}".`,
    )
    return { version: null, problems }
  }

  for (const site of DESKTOP_VERSION_SITES) {
    const contents = read(root, site.file)
    if (contents === null) {
      problems.push(
        `${site.file} is missing, but ${REFERENCE_VERSION_FILE} expects it to restate the version.`,
      )
      continue
    }
    const match = site.pattern.exec(contents)
    if (match === null) {
      problems.push(
        `${site.file} no longer declares the desktop baseline in the expected form. ` +
          `Either restore the declaration or update DESKTOP_VERSION_SITES in scripts/check-versions.mjs.`,
      )
      continue
    }
    if (match[1] !== version) {
      problems.push(
        `${site.file} says ${match[1]}, but ${REFERENCE_VERSION_FILE} says ${version} (${site.note}).`,
      )
    }
  }

  return { version, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { version, problems } = checkVersions()
  if (problems.length > 0) {
    console.error('Desktop baseline version mismatch:\n')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('\nSee docs/versioning.md for which of these are visual-contract changes.')
    process.exit(1)
  }
  console.log(`Desktop baseline ${version}: every copy agrees.`)
}
