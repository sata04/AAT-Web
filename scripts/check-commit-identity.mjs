#!/usr/bin/env node
/**
 * Verify that commits are authored and committed by an approved identity.
 *
 * ## Why this exists
 *
 * This repository's entire initial history — 37 commits — was written as
 * a project name paired with an unrelated personal address, because an agent passed
 * `git -c user.name=… -c user.email=… commit` on every call. The project name
 * is not a person, that address was never an approved committer, and neither
 * would ever have been noticed until the repository went public. Fixing it
 * required rewriting every commit, which changes every SHA — cheap while the
 * repository is private and unreferenced, expensive afterwards. The same thing
 * happened once in sata04/examtrace, which is where this check comes from.
 *
 * The important property: `git var GIT_AUTHOR_IDENT` reports the **effective**
 * identity, after `-c` overrides and `GIT_AUTHOR_*` / `GIT_COMMITTER_*`
 * environment variables have been resolved. A check that reads `git config`
 * would have waved through every one of those 37 commits.
 *
 * ## Modes
 *
 *   (no arguments)      inspect the identity the next commit would carry.
 *                       Used by .githooks/pre-commit.
 *   --range <A>..<B>    inspect every commit in the range. Used by CI, which
 *                       closes the path where someone never installed the hook.
 *                       Note `A..B` excludes A, which is what a pull request
 *                       wants (the base is already on the target branch).
 *   --all               inspect every commit reachable from every ref, root
 *                       commit included. Used to audit a whole repository —
 *                       this is what proves a history rewrite was complete.
 *
 * Extend ALLOWED_IDENTITIES to onboard a person or a bot. It is an allowlist,
 * matched on the full address, so an unknown identity fails closed rather than
 * slipping through on a suffix match.
 */

import { execFileSync } from 'node:child_process'

/**
 * Approved author / committer addresses.
 *
 * GitHub noreply addresses have the form `<id>+<login>@users.noreply.github.com`.
 * Entries are exact strings — never substrings or patterns — so that
 * `evil+sata04@users.noreply.github.com` cannot pass.
 */
const ALLOWED_IDENTITIES = new Map([
  // The repository owner. Confirmed against the account's numeric id (88605918)
  // and the identity used across sata04/AAT and sata04/examtrace.
  ['88605918+sata04@users.noreply.github.com', 'sata04 (repository owner)'],

  // Renovate raises the dependency-update PRs this repository relies on
  // (renovate.json5 enables auto-merge for them), so its commits must pass.
  // The id is Renovate's GitHub App user id:
  //   gh api "users/renovate%5Bbot%5D" --jq .id
  ['29139614+renovate[bot]@users.noreply.github.com', 'Renovate (dependency updates)'],

  // The committer GitHub records for commits created through its API or web UI —
  // squash merges, and the commits Renovate pushes via the App. The author is
  // still checked, so a non-approved person committing through the web UI is
  // still rejected on the author side.
  ['noreply@github.com', 'GitHub web-flow (API and web-UI commits)'],
])

/**
 * Identities that are explicitly NOT approved, listed so the failure message can
 * explain what went wrong instead of just saying "unknown".
 */
const KNOWN_BAD = new Map([
  [
    '[redacted-personal-address]',
    "the address that produced this repository's original bad history — never commit as this",
  ],
])

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

/** Pull the address out of `Name <email> 1700000000 +0900`. */
function emailOf(identity) {
  return /<([^>]*)>/.exec(identity)?.[1] ?? ''
}

/** Pull the display name out of the same string. */
function nameOf(identity) {
  return /^(.*?)\s*</.exec(identity)?.[1] ?? ''
}

/**
 * Reject names that are obviously not a person or an approved bot.
 *
 * The original breakage used the application's own name as the committer. An
 * address can be approved while the name is still wrong, so both are checked.
 */
const FORBIDDEN_NAMES = [/^aat(\s|-|_)?web$/i, /^aat$/i, /^unknown$/i, /^user$/i, /^root$/i]

function describeProblem(role, name, email) {
  if (KNOWN_BAD.has(email)) {
    return `${role} address ${email} — ${KNOWN_BAD.get(email)}`
  }
  if (!ALLOWED_IDENTITIES.has(email)) {
    return `${role} address ${email} is not on the allowlist`
  }
  if (FORBIDDEN_NAMES.some((pattern) => pattern.test(name))) {
    return `${role} name ${JSON.stringify(name)} is a project name, not a committer`
  }
  return null
}

function reportAndExit(problems, context) {
  if (problems.length === 0) {
    console.log(`Commit identity OK (${context}).`)
    process.exit(0)
  }

  console.error(`\nRejected: unapproved commit identity (${context}).\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('\nApproved identities:')
  for (const [email, who] of ALLOWED_IDENTITIES) console.error(`  ${who}: ${email}`)
  console.error(
    [
      '',
      'Fix for a local checkout:',
      '  git config user.name  "sata04"',
      '  git config user.email "88605918+sata04@users.noreply.github.com"',
      '',
      'Do NOT work around this by passing `git -c user.email=...` or by setting',
      'GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL. Those overrides are exactly what',
      'this check exists to catch, and they are how the original bad history',
      'was written. See docs/commit-identity.md.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const rangeIndex = process.argv.indexOf('--range')
const auditAll = process.argv.includes('--all')
const problems = []

if (rangeIndex >= 0 || auditAll) {
  const range = auditAll ? '--all' : process.argv[rangeIndex + 1]
  if (range === undefined || range === '') {
    console.error('--range needs a range of the form A..B')
    process.exit(2)
  }

  // Tab-separated: a commit subject can contain almost anything, so it goes last.
  const output = git(['log', '--format=%H%x09%an%x09%ae%x09%cn%x09%ce%x09%s', range])
  const lines = output === '' ? [] : output.split('\n')
  for (const line of lines) {
    const [sha, authorName, authorEmail, committerName, committerEmail, subject] = line.split('\t')
    for (const [role, name, email] of [
      ['author', authorName ?? '', authorEmail ?? ''],
      ['committer', committerName ?? '', committerEmail ?? ''],
    ]) {
      const problem = describeProblem(role, name, email)
      if (problem !== null) problems.push(`${sha?.slice(0, 9)} ${problem} — ${subject ?? ''}`)
    }
  }
  reportAndExit(problems, `${lines.length} commit(s) in ${range}`)
} else {
  // The effective identity of the commit about to be created. `-c` overrides and
  // GIT_AUTHOR_* / GIT_COMMITTER_* environment variables are already resolved here.
  for (const [role, variable] of [
    ['author', 'GIT_AUTHOR_IDENT'],
    ['committer', 'GIT_COMMITTER_IDENT'],
  ]) {
    const identity = git(['var', variable])
    const problem = describeProblem(role, nameOf(identity), emailOf(identity))
    if (problem !== null) problems.push(problem)
  }
  reportAndExit(problems, 'pending commit')
}
