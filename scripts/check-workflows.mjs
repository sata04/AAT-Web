#!/usr/bin/env node

/**
 * Enforce this repository's GitHub Actions policy, locally, without a runner.
 *
 * ## Why it exists
 *
 * Merging the V1 branch produced a `.github/workflows/ci.yml` with **two `e2e:`
 * jobs**. That is not a syntax error. YAML mappings take the last duplicate key
 * and every parser accepts it silently, so `yaml.safe_load` reports one job,
 * `actions/checkout` reports nothing, and the workflow runs — using whichever
 * definition happened to come second. The two definitions differed in whether
 * they built the poster-renderer image, which decides whether two end-to-end
 * specs run or quietly skip. A merge could therefore have switched off a test
 * without a single line of visible conflict.
 *
 * Nothing catches that class of mistake except looking for it, so this looks for
 * it — along with the other invariants the workflows are supposed to hold, which
 * are otherwise enforced only by whoever reviews the diff.
 *
 * ## Why it is a line scanner rather than a YAML parser
 *
 * Two reasons. The first is that a parser is exactly the wrong tool for the
 * headline check: by the time YAML has been parsed, the duplicate key is gone.
 * The second is that a parser would be a dependency, and `docs/supply-chain.md`
 * is clear about the price of those — this file has to keep working when the
 * lockfile is the thing under change.
 *
 * The cost is that it assumes the conventional two-space workflow layout. It
 * does not guess: if a file does not look like a workflow it says so and fails,
 * rather than passing because it understood nothing.
 *
 * Usage: node scripts/check-workflows.mjs [file...]      (default: .github/workflows/*.yml)
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Actions must be pinned to a full commit SHA; a tag can be moved under us. */
const SHA_PIN = /^[0-9a-f]{40}$/

/**
 * Expression interpolation that must never appear inside a `run:` block.
 *
 * `${{ github.event.* }}` in a shell body is a template substitution performed
 * before the shell sees the line, so anything an outsider can put in a pull
 * request title, a branch name or a commit message becomes shell source. The
 * fix is always the same: pass it through `env:` and reference `"$VAR"`.
 *
 * `github.event_name` and `github.sha` are excluded — they are closed sets or
 * hex, not attacker-authored text — but the workflows here route even those
 * through `env:`, which keeps the rule easy to read.
 */
const RUN_INTERPOLATION = /\$\{\{\s*(github\.event\.[A-Za-z0-9_.[\]'"-]+|github\.head_ref)[^}]*\}\}/

const INDENT = {
  /** `jobs:` sits at column 0. */
  document: /^([a-z_]+):/,
  /** A job key: exactly two spaces, a name, a colon, nothing else. */
  job: /^ {2}([A-Za-z0-9_-]+):\s*$/,
  /** Any key inside a job, at four spaces. */
  jobKey: /^ {4}([A-Za-z0-9_-]+):/,
  /** A step, at six spaces. */
  step: /^ {6}- /,
}

/**
 * Check one workflow's source.
 *
 * Pure — takes text, returns problems — so `scripts/check-workflows.test.mjs`
 * can assert the policy against synthetic workflows instead of against whatever
 * happens to be in `.github/` today.
 *
 * @returns {string[]} one line per problem; empty means the file is compliant.
 */
export function checkWorkflow(name, text) {
  const problems = []
  const lines = text.split('\n')

  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (jobsIndex === -1) {
    return [`${name}: no top-level \`jobs:\` — this does not look like a workflow, so nothing was checked`]
  }

  // --- Document level -------------------------------------------------------

  const header = lines.slice(0, jobsIndex)
  if (!header.some((line) => /^permissions:/.test(line))) {
    problems.push(
      `${name}: no top-level \`permissions:\`. Without it the workflow inherits the repository default, ` +
        'so a later change to that setting silently widens what this workflow can do.',
    )
  }
  const targetLine = lines.findIndex((line) => /^\s*pull_request_target:/.test(line))
  if (targetLine !== -1) {
    problems.push(
      `${name}:${targetLine + 1}: \`pull_request_target\` is forbidden. It runs with the repository's ` +
        'secrets and a writable token; combined with a checkout of the pull request it hands both to ' +
        'unreviewed code. See docs/security-scanning.md.',
    )
  }

  // --- Jobs -----------------------------------------------------------------

  /** @type {{ id: string, line: number, body: string[] }[]} */
  const jobs = []
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    // A non-indented, non-blank, non-comment line ends the jobs block.
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('#')) break
    const match = INDENT.job.exec(line)
    if (match === null) {
      if (jobs.length > 0) jobs[jobs.length - 1].body.push(line)
      continue
    }
    jobs.push({ id: match[1], line: index + 1, body: [] })
  }

  if (jobs.length === 0) {
    return [`${name}: \`jobs:\` is present but no job keys were found at two-space indentation`]
  }

  // THE reason this file exists.
  const seen = new Map()
  for (const job of jobs) {
    const first = seen.get(job.id)
    if (first === undefined) {
      seen.set(job.id, job.line)
      continue
    }
    problems.push(
      `${name}:${job.line}: duplicate job \`${job.id}\` (first defined at line ${first}). ` +
        'YAML keeps the LAST definition and no parser will complain — the earlier one is discarded ' +
        'silently, which is how a merge switches a job off without showing a conflict.',
    )
  }

  for (const job of jobs) {
    const keys = job.body.map((line) => INDENT.jobKey.exec(line)?.[1]).filter(Boolean)
    if (!keys.includes('permissions')) {
      problems.push(
        `${name}:${job.line}: job \`${job.id}\` declares no \`permissions:\`. Every job states the ` +
          'access it needs, so nothing is granted by inheritance.',
      )
    }
    if (!keys.includes('timeout-minutes')) {
      problems.push(
        `${name}:${job.line}: job \`${job.id}\` declares no \`timeout-minutes:\`. The default is six ` +
          'hours of runner time for something that has already hung.',
      )
    }
    problems.push(...checkSteps(name, job))
  }

  return problems
}

function checkSteps(name, job) {
  const problems = []
  /** @type {{ start: number, lines: string[] }[]} */
  const steps = []
  for (const [offset, line] of job.body.entries()) {
    if (INDENT.step.test(line)) steps.push({ start: job.line + offset + 1, lines: [line] })
    else if (steps.length > 0) steps[steps.length - 1].lines.push(line)
  }

  for (const step of steps) {
    const body = step.lines.join('\n')

    const uses = /^\s*(?:- )?uses:\s*(\S+)/m.exec(body)
    if (uses !== null) {
      const reference = uses[1]
      const at = reference.lastIndexOf('@')
      const pinned = at !== -1 && SHA_PIN.test(reference.slice(at + 1))
      if (!pinned) {
        problems.push(
          `${name}:${step.start}: \`${reference}\` is not pinned to a full commit SHA. A tag is a ` +
            'pointer its owner can move after review.',
        )
      }
      if (reference.startsWith('actions/checkout') && !/persist-credentials:\s*false/.test(body)) {
        problems.push(
          `${name}:${step.start}: \`actions/checkout\` without \`persist-credentials: false\` leaves ` +
            'GITHUB_TOKEN in .git/config, where anything that runs afterwards can read it.',
        )
      }
    }

    // Only the shell body of `run:` matters; `env:` and `if:` are not shell.
    for (const [offset, line] of step.lines.entries()) {
      const runKey = /^(\s*)(?:- )?run:/.exec(line)
      if (runKey === null) continue
      const depth = runKey[1].length
      const bodyLines = [line]
      for (let index = offset + 1; index < step.lines.length; index += 1) {
        const next = step.lines[index]
        if (next.trim() !== '' && next.search(/\S/) <= depth) break
        bodyLines.push(next)
      }
      const hit = RUN_INTERPOLATION.exec(bodyLines.join('\n'))
      if (hit !== null) {
        problems.push(
          `${name}:${step.start}: \`${hit[0]}\` is interpolated into a \`run:\` body. Expression ` +
            'substitution happens before the shell parses the line, so outsider-authored text becomes ' +
            'shell source. Pass it through `env:` and reference "$VAR".',
        )
      }
    }
  }

  return problems
}

function main() {
  const explicit = process.argv.slice(2)
  const files =
    explicit.length > 0
      ? explicit
      : readdirSync('.github/workflows')
          .filter((entry) => entry.endsWith('.yml') || entry.endsWith('.yaml'))
          .map((entry) => join('.github/workflows', entry))
          .sort()

  if (files.length === 0) {
    console.error('No workflow files found.')
    process.exit(2)
  }

  const problems = files.flatMap((file) => checkWorkflow(file, readFileSync(file, 'utf8')))

  if (problems.length > 0) {
    for (const problem of problems) console.error(`\n${problem}`)
    console.error(`\n${problems.length} problem(s) in ${files.length} workflow file(s).`)
    process.exit(1)
  }
  console.log(`Workflow policy OK (${files.length} file(s)).`)
}

if (process.argv[1]?.endsWith('check-workflows.mjs')) main()
