#!/usr/bin/env node

/**
 * The version audit: two groups of restated version strings, checked independently.
 *
 * They are deliberately *not* reconciled with each other. AAT Web 1.0.0 renders AAT 11.1.0's
 * figure, so a poster's watermark reading `AAT v11.1.0` while the application is `1.0.0` is the
 * designed state — `docs/versioning.md` §2. What this checker enforces is that each number agrees
 * with *its own* copies.
 *
 * ## Group 1: the desktop baseline
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
 * ## Group 2: AAT Web's own version
 *
 * Written down twice, with no vendored source of truth, and the second copy is load-bearing:
 * `POST /revisions` stores `body.appVersion ?? APP_VERSION`, so a drift makes a revision's
 * recorded provenance depend on whether the client happened to send one. See
 * {@link WEB_VERSION_SITES}.
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
    pattern: /^DESKTOP_BASELINE_VERSION = "(.+?)"$/m,
    note: 'drawn into the poster watermark — moving it changes the pixels of every future figure',
  },
  {
    file: 'apps/web/src/app/version.ts',
    pattern: /^export const DESKTOP_BASELINE_VERSION = '(.+?)'$/m,
    note: 'shown in the about/provenance line',
  },
]

/**
 * AAT Web's *own* release version — a different number answering a different question, and one
 * that is also written down twice.
 *
 * `worker/config.ts`'s copy is the fallback in `POST /revisions`: a snapshot records
 * `body.appVersion ?? APP_VERSION`. So if the two drift, the version stored against a revision
 * depends on whether the client happened to send one — the same class of silent, plausible-looking
 * inconsistency the desktop baseline had, on the field `docs/cloud-data-model.md` describes as
 * "what produced it".
 *
 * There is no third file to make the source of truth here: unlike the desktop baseline, this
 * number is not vendored from anywhere. The browser's copy is treated as authoritative because it
 * is the one a client actually sends; the Worker's only ever stands in for it.
 */
export const WEB_VERSION_SITES = [
  {
    file: 'apps/web/src/app/version.ts',
    pattern: /^export const APP_VERSION = '(.+?)'$/m,
    note: 'the version the browser records in every snapshot it stores',
  },
  {
    file: 'apps/web/worker/config.ts',
    pattern: /^export const APP_VERSION = '(.+?)'$/m,
    note: "the Worker's fallback when a client sends no appVersion — must agree, or provenance depends on the caller",
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
 * Read the version a site declares, or push the reason it could not be read.
 *
 * A file that no longer matches its pattern is a *problem*, never a skip. That is the failure the
 * obvious implementation gets wrong: deleting the constant makes "no mismatch found" trivially
 * true, and the audit reports success for a repository that has stopped declaring the thing it
 * was auditing.
 */
function declaredVersion(root, site, label, problems) {
  const contents = read(root, site.file)
  if (contents === null) {
    problems.push(`${site.file} is missing, but it is expected to declare the ${label}.`)
    return null
  }
  const match = site.pattern.exec(contents)
  if (match === null) {
    problems.push(
      `${site.file} no longer declares the ${label} in the expected form. ` +
        `Either restore the declaration or update scripts/check-versions.mjs.`,
    )
    return null
  }
  return match[1]
}

/**
 * Audit the repository at `root`.
 *
 * Returns `{ desktopBaseline, webVersion, problems }`; `problems` is empty when every copy of
 * every version agrees. Never throws for a content problem — the caller decides how to report.
 *
 * The two version groups are checked independently and are *expected to differ from each other*:
 * AAT Web 1.0.0 renders AAT 11.1.0's figure, and that is not a discrepancy to reconcile. See
 * `docs/versioning.md`.
 */
export function checkVersions(root = REPO_ROOT) {
  const problems = []

  // --- the desktop baseline, against its vendored source of truth ---------------------------
  let desktopBaseline = null
  const raw = read(root, REFERENCE_VERSION_FILE)
  if (raw === null) {
    problems.push(`${REFERENCE_VERSION_FILE} is missing; it is the source of truth for the desktop baseline.`)
  } else {
    const version = raw.trim()
    if (!SEMVER.test(version)) {
      problems.push(
        `${REFERENCE_VERSION_FILE} must contain a bare MAJOR.MINOR.PATCH version, got "${version}".`,
      )
    } else {
      desktopBaseline = version
      for (const site of DESKTOP_VERSION_SITES) {
        const declared = declaredVersion(root, site, 'desktop baseline', problems)
        if (declared !== null && declared !== version) {
          problems.push(
            `${site.file} says ${declared}, but ${REFERENCE_VERSION_FILE} says ${version} (${site.note}).`,
          )
        }
      }
    }
  }

  // --- AAT Web's own version, against its first declaring site -------------------------------
  // Nothing vendors this one, so the first site is the reference and the rest must match it.
  let webVersion = null
  for (const site of WEB_VERSION_SITES) {
    const declared = declaredVersion(root, site, 'AAT Web version', problems)
    if (declared === null) continue
    if (webVersion === null) {
      webVersion = declared
      if (!SEMVER.test(declared)) {
        problems.push(`${site.file} must declare a bare MAJOR.MINOR.PATCH version, got "${declared}".`)
      }
      continue
    }
    if (declared !== webVersion) {
      problems.push(
        `${site.file} says ${declared}, but ${WEB_VERSION_SITES[0].file} says ${webVersion} (${site.note}).`,
      )
    }
  }

  return { desktopBaseline, webVersion, problems }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { desktopBaseline, webVersion, problems } = checkVersions()
  if (problems.length > 0) {
    console.error('Version mismatch:\n')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('\nSee docs/versioning.md for which of these are visual-contract changes.')
    process.exit(1)
  }
  console.log(`AAT Web ${webVersion} rendering AAT ${desktopBaseline}'s figure: every copy of both agrees.`)
}
