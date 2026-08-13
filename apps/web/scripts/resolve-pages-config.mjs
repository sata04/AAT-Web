#!/usr/bin/env node

/**
 * Writes the deploy-time `wrangler.jsonc` for the Pages project.
 *
 * ## Why the file is generated rather than committed
 *
 * A Pages project's public hostname is mechanically its project name, and this
 * repository does not carry the hostname of its own deployment — the same reason
 * `AAT_RP_ID` and `AAT_TRUSTED_ORIGINS` are Worker secrets rather than `vars`.
 * Committing the project name would publish the origin, so the name comes from
 * Doppler at deploy time and this script assembles the rest around it.
 *
 * ## Why it cannot simply live beside the Worker's config
 *
 * `wrangler pages deploy` has no `--config` flag. Its only global flags are
 * `--cwd`, `--env-file`, `--help`, `--install-skills`, `--profile` and
 * `--version`; it looks for `wrangler.jsonc` or `wrangler.toml` in the working
 * directory and nowhere else. `apps/web/wrangler.jsonc` is the *Worker's*: it has
 * `main` and no `pages_build_output_dir`, so Pages warns that the file is
 * "missing the pages_build_output_dir field", ignores it, and deploys anyway —
 * without the service binding, which would make `env.AAT_API` undefined and fail
 * every single `/api/*` request on an otherwise green deploy. A file named
 * `wrangler.pages.jsonc` beside it would not even be looked at, silently.
 *
 * So the Pages project gets its own directory, `apps/web/pages/`, holding the
 * Function and this generated file, and the deploy runs with `--cwd` pointing at
 * it. The generated file is gitignored.
 *
 * ## Everything that can be derived, is
 *
 * The compatibility date, the compatibility flags and the bound Worker's name are
 * read out of `apps/web/wrangler.jsonc` rather than repeated here. Those three
 * values have to agree with the Worker's or the deployment is subtly wrong — a
 * compatibility date ahead of the pinned workerd, or a service binding naming a
 * Worker that no longer exists — and the only way to guarantee agreement is to
 * have one source.
 *
 * Usage: AAT_PAGES_PROJECT=<name> node scripts/resolve-pages-config.mjs [output-path]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** `apps/web`. */
const APP_ROOT = join(here, '..')

const WORKER_CONFIG = join(APP_ROOT, 'wrangler.jsonc')
const DEFAULT_OUTPUT = join(APP_ROOT, 'pages', 'wrangler.jsonc')

/**
 * The binding name the Pages Function reads.
 *
 * It is declared in `pages/functions/api/[[path]].ts` as well, and the two have
 * to match exactly — a mismatch is `undefined` at runtime and a 502 across the
 * whole API. `apps/web/pages/tsconfig.json` typechecks the Function's side;
 * this constant is the other side, and the assertion below keeps them together.
 */
const SERVICE_BINDING = 'AAT_API'

/** Strip JSONC comments well enough to parse a file this project controls. */
function parseJsonc(text) {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const withoutLines = withoutBlocks.replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(withoutLines)
}

const projectName = process.env.AAT_PAGES_PROJECT
if (!projectName) {
  console.error('AAT_PAGES_PROJECT is not set. It is the Pages project name, held in Doppler.')
  process.exit(1)
}

const worker = parseJsonc(readFileSync(WORKER_CONFIG, 'utf8'))

for (const [field, value] of Object.entries({
  name: worker.name,
  compatibility_date: worker.compatibility_date,
  compatibility_flags: worker.compatibility_flags,
})) {
  if (value === undefined) {
    console.error(`${WORKER_CONFIG} has no "${field}" — cannot derive the Pages configuration from it.`)
    process.exit(1)
  }
}

/*
 * The Function has to be able to reach the Worker, and a Worker that still
 * serves its own assets would mean the migration is half-done: two public
 * origins, two WebAuthn origins, and a second unauthenticated path to D1 and R2.
 */
if (worker.assets !== undefined) {
  console.error(`${WORKER_CONFIG} still declares "assets". Pages serves the client now; remove it.`)
  process.exit(1)
}
if (worker.workers_dev !== false) {
  console.error(`${WORKER_CONFIG} must set "workers_dev": false — the API Worker has no public origin.`)
  process.exit(1)
}

const functionSource = readFileSync(join(APP_ROOT, 'pages/functions/api/[[path]].ts'), 'utf8')
if (!functionSource.includes(SERVICE_BINDING)) {
  console.error(
    `The Pages Function does not mention the binding "${SERVICE_BINDING}". ` +
      'A binding named here but read under another name is undefined at runtime, which is a 502 ' +
      'on every /api/* request.',
  )
  process.exit(1)
}

/*
 * The Function must import nothing.
 *
 * `wrangler pages deploy` compiles the functions directory with esbuild at
 * deploy time — inside the job that holds the Cloudflare token and can mint the
 * Doppler OIDC token. deploy.yml's whole design is that repository code and
 * production credentials never occupy the same job, and this is the one place
 * that cannot be honoured literally: there is no supported way to pre-compile a
 * Pages Function without switching to advanced mode, where a `_worker.js` takes
 * over every request and the routing model changes entirely.
 *
 * What is possible is to bound it. A Function with no imports compiles to
 * itself: esbuild resolves nothing, reads no node_modules, and the code running
 * beside the credentials is exactly the file in this repository that a reviewer
 * read. The moment an import appears, that guarantee is gone and the trade needs
 * making again deliberately — which is what this assertion forces.
 */
const imports = functionSource.match(/^\s*import[\s{*].*/gm) ?? []
if (imports.length > 0) {
  console.error(
    'The Pages Function imports something:\n' +
      imports.map((line) => `  ${line.trim()}`).join('\n') +
      '\n\nIt must stay self-contained. `wrangler pages deploy` compiles this directory inside the\n' +
      'credential-bearing deploy job, and a Function with no imports is a Function whose compiled\n' +
      'output cannot contain anything but itself. See the note in .github/workflows/deploy.yml.',
  )
  process.exit(1)
}

/*
 * `services` is deliberately at the top level rather than under `env.production`.
 *
 * Top-level keys apply to local, production and preview alike. The moment any
 * non-inheritable key is overridden for one environment, EVERY non-inheritable
 * key must be restated for that environment or the deploy fails validation — so
 * a flat config is not laziness, it is the shape that cannot half-apply.
 *
 * `pages_build_output_dir` is resolved relative to this file, which is why the
 * output goes next to the functions directory rather than into a temporary path.
 */
const config = {
  name: projectName,
  pages_build_output_dir: '../dist/client',
  compatibility_date: worker.compatibility_date,
  compatibility_flags: worker.compatibility_flags,
  services: [{ binding: SERVICE_BINDING, service: worker.name }],
}

const outputPath = process.argv[2] ?? DEFAULT_OUTPUT
writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`)

// The project name is the public hostname; it is not printed.
console.log(
  `Wrote ${outputPath}: binding ${SERVICE_BINDING} -> ${worker.name}, ` +
    `compatibility ${worker.compatibility_date} [${worker.compatibility_flags.join(', ')}]`,
)
