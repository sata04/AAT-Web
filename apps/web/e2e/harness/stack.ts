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
import { rm } from 'node:fs/promises'
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
 * The sandbox this repository is developed in exports HTTP(S)_PROXY. Wrangler, Vite and — more
 * importantly — the Worker's own outbound `fetch` to the renderer must not be sent through it.
 */
const NO_PROXY_ENV = { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' }

export interface Stack {
  baseUrl: string
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
      String(PORT),
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

  const harnessFetch = (path: string) =>
    fetch(`${BASE_URL}${path}`, { headers: { 'x-e2e-token': harnessToken } })

  try {
    await waitFor(
      'the Worker',
      120_000,
      async () => (await harnessFetch('/__e2e__/ready')).ok,
      () => log.join(''),
    )
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
    await stopAll(worker, rendererAvailable)
    throw error
  }

  return {
    baseUrl: BASE_URL,
    harnessToken,
    rendererAvailable,
    stop: () => stopAll(worker, rendererAvailable),
  }
}

async function stopAll(worker: ChildProcess, rendererStarted: boolean): Promise<void> {
  if (worker.exitCode === null && worker.signalCode === null) {
    const ended = new Promise<void>((resolve) => worker.once('close', () => resolve()))
    worker.kill('SIGTERM')
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 10_000))])
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL')
  }
  if (rendererStarted) {
    await run('docker', ['rm', '-f', RENDERER_CONTAINER], 'docker rm')
  }
}
