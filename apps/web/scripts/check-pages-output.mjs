#!/usr/bin/env node

/**
 * Assert the things Pages decides by looking at the build output rather than by
 * reading configuration.
 *
 * Workers Static Assets took `not_found_handling: "single-page-application"` and
 * `run_worker_first: ["/api/*"]` from `wrangler.jsonc`, where a mistake is a
 * visible diff. On Pages both properties are inferred: SPA fallback happens only
 * while there is no top-level `404.html`, and Function invocation is scoped only
 * by `_routes.json`. Neither has a config key to review, `wrangler pages dev`
 * ignores `_routes.json` entirely, and both fail in the same direction — a
 * plausible-looking 200 that is the wrong document.
 *
 * So they are asserted here, against the directory that is about to be uploaded.
 *
 * Usage: node scripts/check-pages-output.mjs [dist/client]
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const directory = process.argv[2] ?? 'dist/client'
const problems = []

if (!existsSync(directory)) {
  console.error(`No build output at ${directory}. Run \`pnpm build\` first.`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

if (!existsSync(join(directory, 'index.html'))) {
  problems.push(`${directory}/index.html is missing — there is nothing for Pages to fall back to.`)
}

/*
 * The whole mechanism. Pages serves the root document for unmatched paths *only*
 * while no top-level 404.html exists; ship one and client-side routes such as
 * `/register?token=...` — the invitation link, the one URL a new user is sent —
 * start returning it instead of the application.
 *
 * Nothing emits a 404.html today. A Vite plugin, a docs page, or a future
 * prerender step easily could, and it would look like an improvement.
 */
if (existsSync(join(directory, '404.html'))) {
  problems.push(
    `${directory}/404.html exists, which silently turns OFF Pages' SPA fallback. ` +
      'Client-side routes such as /register?token=... would serve that file instead of the ' +
      'application. Remove it, or move the deployment back to explicit not_found_handling.',
  )
}

// ---------------------------------------------------------------------------
// Function scoping
// ---------------------------------------------------------------------------

const routesPath = join(directory, '_routes.json')
if (!existsSync(routesPath)) {
  problems.push(
    `${routesPath} is missing. Pages would generate its own, routing far more than /api/* through ` +
      'the Function — every static request would then cost an invocation.',
  )
} else {
  let routes
  try {
    routes = JSON.parse(readFileSync(routesPath, 'utf8'))
  } catch (error) {
    problems.push(`${routesPath} is not valid JSON: ${error.message}`)
  }

  if (routes !== undefined) {
    if (routes.version !== 1) problems.push(`${routesPath}: "version" must be 1, found ${routes.version}`)
    if (!Array.isArray(routes.include) || routes.include.length === 0) {
      problems.push(`${routesPath}: "include" must be a non-empty array; at least one rule is required.`)
    }
    // Not optional, and not merely pedantic: wrangler's validator requires the
    // key to be an array, and a missing one aborts the deploy.
    if (!Array.isArray(routes.exclude)) {
      problems.push(`${routesPath}: "exclude" must be present, as an array (empty is correct here).`)
    }
    /*
     * `exclude` always beats `include`. The tempting-looking pair
     * include:["/api/*"] + exclude:["/*"] therefore excludes /api/* as well, the
     * Function is never invoked, and every API call falls through to the static
     * pipeline and returns index.html with HTTP 200 — HTML where the client
     * parses JSON. Scoping is done with `include` alone.
     */
    if (Array.isArray(routes.exclude) && routes.exclude.length > 0) {
      problems.push(
        `${routesPath}: "exclude" is non-empty. exclude always wins over include, so any rule here ` +
          'can silently switch the API off. Scope with "include" alone.',
      )
    }
    if (Array.isArray(routes.include) && !routes.include.includes('/api/*')) {
      problems.push(`${routesPath}: "include" must contain "/api/*", found ${JSON.stringify(routes.include)}`)
    }
    for (const rule of [...(routes.include ?? []), ...(routes.exclude ?? [])]) {
      if (typeof rule !== 'string' || !rule.startsWith('/')) {
        problems.push(
          `${routesPath}: every rule must be a string starting with "/", found ${JSON.stringify(rule)}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The policy against what the bundle actually does
// ---------------------------------------------------------------------------

/*
 * A Content-Security-Policy is only ever tested by a browser loading the real
 * headers, and nothing in this repository does that: `wrangler pages dev` is
 * what the end-to-end suite runs against, and the suite therefore never saw the
 * policy at all. The first thing to find the mismatch was a person using the
 * deployed site — `worker-src 'self'` blocked the blob worker fflate spawns to
 * compress an XLSX, so "export to Excel" failed in production while every test
 * passed.
 *
 * This cannot substitute for a browser, but it can compare the policy with what
 * the bundle demonstrably does. Both halves are greppable, and a mismatch is
 * exactly the shape of the bug that shipped.
 */
const headersPath = join(directory, '_headers')
if (!existsSync(headersPath)) {
  problems.push(`${headersPath} is missing — the security headers would not be applied.`)
} else {
  const csp = /Content-Security-Policy:\s*(.+)/.exec(readFileSync(headersPath, 'utf8'))?.[1] ?? ''
  const directives = Object.fromEntries(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/)
        return [name, values]
      }),
  )

  const scripts = readdirSync(join(directory, 'assets'), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => readFileSync(join(directory, 'assets', entry.name), 'utf8'))

  // A worker built from a Blob. Written by fflate and by most bundled libraries
  // that ship one; matched on the construction rather than on a library name so
  // a different dependency doing the same thing is caught too.
  const buildsBlobWorker = scripts.some((source) => /new Worker\([^)]*createObjectURL/.test(source))
  if (buildsBlobWorker && !(directives['worker-src'] ?? []).includes('blob:')) {
    problems.push(
      "The bundle constructs a Worker from a Blob URL, but the policy's worker-src does not allow " +
        '`blob:`. The browser will refuse it and whatever that worker does will fail in production ' +
        'while every test here passes.',
    )
  }

  // Nothing in this application should need string evaluation. If a dependency
  // starts requiring it, that is a decision to take deliberately, not a header
  // to loosen quietly.
  const evaluatesStrings = scripts.some((source) => /new Function\(|[^\w.]eval\(/.test(source))
  if (evaluatesStrings && !(directives['script-src'] ?? []).includes("'unsafe-eval'")) {
    problems.push(
      'The bundle calls eval() or new Function(), which script-src forbids. Find the dependency ' +
        'that introduced it rather than adding `unsafe-eval`.',
    )
  }
}

// ---------------------------------------------------------------------------

if (problems.length > 0) {
  for (const problem of problems) console.error(`\n${problem}`)
  console.error(`\n${problems.length} problem(s) with ${directory}.`)
  process.exit(1)
}

console.log(`Pages output OK: SPA fallback active, Functions scoped to /api/* (${directory}).`)
