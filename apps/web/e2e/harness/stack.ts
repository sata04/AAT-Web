/**
 * The local stack the end-to-end suite runs against.
 *
 * Four processes, started in this order and torn down in reverse:
 *
 *   1. `vite build`            — the real client bundle, into `dist/client`.
 *   2. `wrangler d1 migrations apply --local` — the committed migrations, against an empty
 *      database. The state directory is deleted first, so every run starts from nothing and a
 *      migration that no longer applies fails the suite immediately rather than being papered over
 *      by yesterday's database.
 *   3. `docker run aat-poster-renderer` — the pinned Python + Matplotlib renderer, published on a
 *      loopback port. Optional: without it the poster specs report the container as missing rather
 *      than silently passing against a fake.
 *   4. `wrangler dev --local`  — `workerd` serving the static assets, the real Worker, a local D1
 *      and a local R2.
 *
 * Nothing here reaches Cloudflare. `--local` keeps every binding in-process, the auth values are
 * the development-only ones committed in `wrangler.e2e.jsonc`, and the two per-run values
 * (`E2E_HARNESS_TOKEN`, `POSTER_RENDERER_URL`) are injected with `--var` so they never appear in a
 * committed file at all.
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** `apps/web`. Every command below runs from here, so relative paths mean one thing. */
export const APP_ROOT = path.resolve(here, '../..')
/** The repository root, for the shared CSV fixtures under `tests/fixtures/`. */
export const REPO_ROOT = path.resolve(APP_ROOT, '../..')

/**
 * Fixed, because `AAT_TRUSTED_ORIGINS` and `BETTER_AUTH_URL` in `wrangler.e2e.jsonc` name it
 * exactly and WebAuthn origins are compared by equality, never by suffix. A busy port therefore
 * fails the run loudly instead of producing a stack whose ceremonies would all be refused.
 */
export const PORT = 8788
export const BASE_URL = `http://localhost:${PORT}`

/**
 * The private API Worker's port.
 *
 * Nothing in the suite talks to it directly — the browser and the harness both
 * go through PORT, which is the whole point: the deployed shape has a Pages
 * Function in front, and a test that bypassed it would be testing a topology
 * that no longer exists. It is fixed only so the Pages dev server can be told
 * where to find it.
 */
export const API_PORT = 8787

/** Loopback-only publish of the renderer container's 8080. */
export const RENDERER_PORT = 8099
const RENDERER_IMAGE = process.env.AAT_E2E_RENDERER_IMAGE ?? 'aat-poster-renderer:ci'
const RENDERER_CONTAINER = 'aat-web-e2e-poster-renderer'

const WRANGLER = path.join(APP_ROOT, 'node_modules/wrangler/bin/wrangler.js')
const VITE = path.join(APP_ROOT, 'node_modules/vite/bin/vite.js')
const CONFIG = 'e2e/wrangler.e2e.jsonc'
const PERSIST = 'e2e/.wrangler/state'
const DATABASE = 'aat-e2e-db'

/**
 * Where the Pages Function lives.
 *
 * It is NOT where `wrangler pages dev` is run from, and that distinction cost an
 * afternoon. `pages dev` ignores any configuration file in its working directory
 * — verified: it reports `configFileType: "none"` with a valid `wrangler.json`
 * sitting right there — and then walks UP the tree until it finds one. From
 * anywhere inside `apps/web` that is `apps/web/wrangler.jsonc`, the *Worker's*
 * config, whose `containers` block names a deliberately invalid image; wrangler
 * refuses to start on it ("does not belong to your account") and the whole suite
 * dies in global setup with a timeout that names nothing useful.
 *
 * So the dev server runs from a scratch directory outside the repository, where
 * the walk finds nothing, and this directory is symlinked in as `functions/`.
 * esbuild resolves through the symlink to the real path, so the re-export in
 * `functions/api/[[path]].ts` still reaches the production Function — the suite
 * runs the deployed handler, not a copy of it.
 */
const PAGES_FUNCTIONS = path.join(APP_ROOT, 'e2e/pages/functions')
/**
 * Must equal `name` in e2e/wrangler.e2e.jsonc.
 *
 * `--service BINDING=SCRIPT_NAME` resolves through wrangler's dev registry by
 * script name. Rename the Worker without changing this and every API call
 * answers 503 — not a startup error, which is why the readiness poll below
 * waits on an /api/ route rather than on the front page.
 */
const API_SCRIPT_NAME = 'aat-api-e2e'
/** The binding the Pages Function reads. Must equal SERVICE_BINDING in scripts/resolve-pages-config.mjs. */
const API_BINDING = 'AAT_API'
/** Must equal `compatibility_date` in e2e/wrangler.e2e.jsonc and apps/web/wrangler.jsonc. */
const COMPATIBILITY_DATE = '2026-07-30'

/**
 * The sandbox this repository is developed in exports HTTP(S)_PROXY. Wrangler, Vite and — more
 * importantly — the Worker's own outbound `fetch` to the renderer must not be sent through it.
 */
const NO_PROXY_ENV = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }

export interface Stack {
  baseUrl: string
  /** The private Worker's port. Only the harness's SQL endpoint uses it; the browser never does. */
  apiUrl: string
  harnessToken: string
  /** False when Docker or the renderer image was unavailable; the poster specs say so and skip. */
  rendererAvailable: boolean
  stop: () => Promise<void>
}

function run(command: string, args: string[], label: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: APP_ROOT,
      env: { ...process.env, ...NO_PROXY_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.on('error', (error) => reject(new Error(`${label} could not start: ${error.message}`)))
    child.on('close', (code) => resolve({ code: code ?? -1, output }))
  })
}

async function mustRun(command: string, args: string[], label: string): Promise<string> {
  const result = await run(command, args, label)
  if (result.code !== 0) {
    throw new Error(`${label} failed with exit code ${result.code}:\n${result.output}`)
  }
  return result.output
}

/**
 * Poll `check` until it answers true.
 *
 * Every wait in this harness is a wait on a real condition — the Worker answering, the renderer
 * answering — never a sleep of a guessed length. A guessed sleep is how an end-to-end suite becomes
 * both slow and flaky at the same time.
 */
async function waitFor(
  label: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
  onTimeout?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  for (;;) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) {
      const extra = onTimeout === undefined ? '' : `\n${onTimeout()}`
      throw new Error(`${label} did not become ready within ${timeoutMs} ms (${lastError})${extra}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

async function startRenderer(): Promise<boolean> {
  if (process.env.AAT_E2E_SKIP_RENDERER === '1') return false

  const images = await run('docker', ['images', '-q', RENDERER_IMAGE], 'docker images')
  if (images.code !== 0) {
    process.stderr.write(
      `[e2e] Docker is not usable (${images.output.trim()}). The real-renderer specs will report it.\n`,
    )
    return false
  }
  if (images.output.trim() === '') {
    process.stderr.write(
      `[e2e] The image ${RENDERER_IMAGE} is not present. Build it with ` +
        '`docker build -t aat-poster-renderer:ci poster-renderer`. The real-renderer specs will report it.\n',
    )
    return false
  }

  await run('docker', ['rm', '-f', RENDERER_CONTAINER], 'docker rm')
  await mustRun(
    'docker',
    [
      'run',
      '--detach',
      '--name',
      RENDERER_CONTAINER,
      // The renderer takes its input in the request body and needs no outbound network of its own;
      // production runs it with `enableInternet: false`, and CI with `--network none`. It still
      // needs its published port here, so the network is left in place but nothing is reachable
      // from it that the container asks for.
      '--publish',
      `127.0.0.1:${RENDERER_PORT}:8080`,
      RENDERER_IMAGE,
    ],
    'docker run',
  )
  return true
}

export async function startStack(): Promise<Stack> {
  const harnessToken = randomBytes(24).toString('base64url')

  if (process.env.AAT_E2E_SKIP_BUILD !== '1') {
    await mustRun(process.execPath, [VITE, 'build'], 'vite build')
  }

  // A fresh database for every run. `applyD1Migrations` in the workerd suite makes the same
  // guarantee for that suite; this is its equivalent here.
  await rm(path.join(APP_ROOT, PERSIST), { recursive: true, force: true })
  await mustRun(
    process.execPath,
    [WRANGLER, 'd1', 'migrations', 'apply', DATABASE, '--local', '-c', CONFIG, '--persist-to', PERSIST],
    'd1 migrations apply',
  )

  const rendererAvailable = await startRenderer()

  const log: string[] = []
  const worker: ChildProcess = spawn(
    process.execPath,
    [
      WRANGLER,
      'dev',
      '-c',
      CONFIG,
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(API_PORT),
      // Both `wrangler dev` and `wrangler pages dev` default their inspector to
      // 9229. Two processes on one machine means the second fails to bind — and
      // it fails on the inspector, not on the HTTP port, which reads as an
      // unrelated crash.
      '--inspector-port',
      '9329',
      '--persist-to',
      PERSIST,
      '--show-interactive-dev-session=false',
      '--log-level',
      'info',
      '--var',
      `E2E_HARNESS_TOKEN:${harnessToken}`,
      '--var',
      `POSTER_RENDERER_URL:http://127.0.0.1:${RENDERER_PORT}`,
    ],
    {
      cwd: APP_ROOT,
      env: { ...process.env, ...NO_PROXY_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  worker.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()))
  worker.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()))

  /*
   * The public half: a Pages dev server serving the built client, with the
   * Function that forwards to the Worker above.
   *
   * Started second. The dev registry reattaches if the order is reversed, but a
   * request that lands in the gap gets a 503 from the unconnected binding rather
   * than an error anyone would recognise — so the Worker goes first and the
   * readiness poll below waits on a route that has to travel the whole chain.
   *
   * `--cwd` rather than a config path: `wrangler pages dev` rejects `--config`
   * outright, so e2e/pages/wrangler.jsonc is found only by being in the working
   * directory. Its own persistence directory, because two miniflare processes
   * sharing one SQLite state directory is nowhere documented as safe; this one
   * has no storage bindings, so the directory stays empty.
   */
  const pagesRoot = await mkdtemp(path.join(tmpdir(), 'aat-e2e-pages-'))
  await symlink(PAGES_FUNCTIONS, path.join(pagesRoot, 'functions'), 'dir')

  const pages: ChildProcess = spawn(
    process.execPath,
    [
      WRANGLER,
      'pages',
      'dev',
      // Absolute, because the working directory is a scratch path elsewhere.
      path.join(APP_ROOT, 'dist/client'),
      // With no configuration file there is nothing to read these from, and an
      // omitted compatibility date defaults to *today* — which is ahead of the
      // pinned workerd, so it refuses to boot and the failure looks like a hang.
      '--compatibility-date',
      COMPATIBILITY_DATE,
      '--compatibility-flags',
      'nodejs_compat',
      '--ip',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--inspector-port',
      '9330',
      '--service',
      `${API_BINDING}=${API_SCRIPT_NAME}`,
      '--persist-to',
      path.join(pagesRoot, 'state'),
      '--show-interactive-dev-session=false',
      '--log-level',
      'info',
    ],
    { cwd: pagesRoot, env: { ...process.env, ...NO_PROXY_ENV }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  pages.stdout?.on('data', (chunk: Buffer) => log.push(`[pages] ${chunk.toString()}`))
  pages.stderr?.on('data', (chunk: Buffer) => log.push(`[pages] ${chunk.toString()}`))

  const apiUrl = `http://127.0.0.1:${API_PORT}`
  const harnessFetch = (path: string) =>
    fetch(`${apiUrl}${path}`, { headers: { 'x-e2e-token': harnessToken } })
  /** The browser's door. Answers 503 until the Pages Function's binding connects. */
  const frontDoorReady = async () => (await fetch(`${BASE_URL}/api/v1/me`)).status !== 503

  try {
    /*
     * One poll, through the whole chain, on purpose.
     *
     * `/__e2e__/ready` leaves the browser's port, is claimed by a Pages Function,
     * crosses the Service binding and is answered by the Worker. Waiting on the
     * front page instead would go green as soon as the static half was up —
     * which happens well before the binding connects, and every test would then
     * race a 503 that the suite would report as a product failure.
     */
    await waitFor(
      'the API Worker',
      120_000,
      async () => (await harnessFetch('/__e2e__/ready')).ok,
      () => log.join(''),
    )
    /*
     * Then the front door, separately, because they fail differently. A 503 here
     * is the Service binding not yet connected — the static half is up long
     * before that, so waiting on `GET /` would go green while every API call in
     * every test raced a 503 the suite would report as a product bug.
     */
    await waitFor('the Pages front door', 120_000, frontDoorReady, () => log.join(''))
    if (rendererAvailable) {
      // Through the Durable Object, which is the path a poster render actually takes.
      await waitFor(
        'the poster renderer',
        120_000,
        async () => (await harnessFetch('/__e2e__/renderer')).ok,
        () => log.join(''),
      )
    }
  } catch (error) {
    await stopAll([pages, worker], rendererAvailable, pagesRoot)
    throw error
  }

  return {
    baseUrl: BASE_URL,
    apiUrl,
    harnessToken,
    rendererAvailable,
    stop: () => stopAll([pages, worker], rendererAvailable, pagesRoot),
  }
}

/** Ends a child, politely first. Returns once it is gone or the deadline passes. */
async function end(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

/**
 * Torn down in the order given — Pages before the Worker, the reverse of
 * startup, so nothing is left holding a binding to a process that has gone.
 */
async function stopAll(children: ChildProcess[], rendererStarted: boolean, pagesRoot: string): Promise<void> {
  for (const child of children) await end(child)
  if (rendererStarted) {
    await run('docker', ['rm', '-f', RENDERER_CONTAINER], 'docker rm')
  }
  // `force` so a crashed run cannot leave the next one unable to start.
  await rm(pagesRoot, { recursive: true, force: true })
}
