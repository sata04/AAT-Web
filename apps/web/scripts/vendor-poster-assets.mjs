#!/usr/bin/env node
/**
 * Materialises the Pyodide runtime + the wheels the poster engine needs into
 * `node_modules/.cache/poster-assets/pyodide/<version>/`.
 *
 * Why this exists: `connect-src 'self'` means the engine may never fetch wheels from the Pyodide
 * CDN at runtime, so every byte Pyodide will ask for must be vendored ahead of time and served
 * from this origin. The npm `pyodide` package only contains the loader core — the package wheels
 * (matplotlib, numpy, pillow and their dependencies) are fetched by `loadPackage()` from
 * `packageBaseUrl`, which is exactly what the directory produced here becomes.
 *
 * What it vendors:
 *   - the four loader-core files (`pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip`,
 *     `pyodide-lock.json`) straight out of the installed npm package — `pyodide.mjs` itself is
 *     bundled by Vite, so it is *not* copied;
 *   - every wheel in the `matplotlib` dependency closure of `pyodide-lock.json`, downloaded from
 *     the official `cdn.jsdelivr.net/pyodide` mirror and verified against the lockfile's sha256.
 *
 * The layout is versioned (`pyodide/<version>/`) so every asset URL is immutable across a pyodide
 * upgrade — the service worker can cache them CacheFirst forever. It is also safe to run on every
 * dev/build start: files already present are skipped (they are content-addressed by the lock's
 * hashes, and the core files come from the version-pinned package).
 *
 * Exits non-zero on any failure — a half-vendored directory would surface much later as an
 * opaque engine boot failure, so this script errs on the side of failing the build early.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The runtime core always loads these four names from indexURL — see pyodide's own loader.
const CORE_FILES = ['pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']

// The poster engine's Python needs exactly these top-level packages; their transitive
// dependencies are resolved from the lock file rather than hard-coded so a pyodide bump
// re-derives the list instead of silently vendoring a stale set.
const ROOT_PACKAGES = ['matplotlib', 'numpy', 'pillow']

const CDN_BASE = 'https://cdn.jsdelivr.net/pyodide'

function resolvePyodidePackage() {
  // Resolve from apps/web's own package.json so pnpm's non-hoisted layout works.
  const require = createRequire(join(APP_DIR, 'package.json'))
  const packageJsonPath = require.resolve('pyodide/package.json')
  const packageDir = dirname(packageJsonPath)
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  return { packageDir, version }
}

function wheelClosure(lock) {
  const wanted = new Set()
  const queue = [...ROOT_PACKAGES]
  while (queue.length > 0) {
    const name = queue.shift()
    if (wanted.has(name)) continue
    const entry = lock.packages[name]
    if (!entry) throw new Error(`pyodide-lock.json has no package '${name}'`)
    wanted.add(name)
    for (const dep of entry.depends ?? []) queue.push(dep)
  }
  return [...wanted].map((name) => ({ name, ...lock.packages[name] }))
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function download(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

export async function vendorPosterAssets() {
  const { packageDir, version } = resolvePyodidePackage()
  const outDir = join(APP_DIR, 'node_modules', '.cache', 'poster-assets', 'pyodide', version)
  mkdirSync(outDir, { recursive: true })

  let copied = 0
  let bytes = 0
  for (const file of CORE_FILES) {
    const src = join(packageDir, file)
    const dest = join(outDir, file)
    if (!existsSync(dest) || statSync(dest).size !== statSync(src).size) {
      copyFileSync(src, dest)
      copied++
    }
    bytes += statSync(dest).size
  }

  const lock = JSON.parse(readFileSync(join(outDir, 'pyodide-lock.json'), 'utf8'))
  const wheels = wheelClosure(lock)
  let downloaded = 0
  for (const wheel of wheels) {
    const dest = join(outDir, wheel.file_name)
    if (!existsSync(dest)) {
      const body = await download(`${CDN_BASE}/v${version}/full/${wheel.file_name}`)
      const digest = sha256Hex(body)
      if (digest !== wheel.sha256) {
        throw new Error(`sha256 mismatch for ${wheel.file_name}: got ${digest}, want ${wheel.sha256}`)
      }
      // Write via a temp path + rename so a killed run never leaves a truncated wheel in place.
      const tmp = `${dest}.partial`
      writeFileSync(tmp, body)
      renameSync(tmp, dest)
      downloaded++
    }
    bytes += statSync(dest).size
  }

  const mib = (bytes / 1024 / 1024).toFixed(1)
  console.log(
    `[poster-assets] pyodide ${version}: ${CORE_FILES.length} core files, ` +
      `${wheels.length} wheels -> ${outDir} (${mib} MiB; ${copied} copied, ${downloaded} downloaded)`,
  )
  return { version, outDir, wheels }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  vendorPosterAssets().catch((error) => {
    console.error(`[poster-assets] FAILED: ${error.message}`)
    process.exitCode = 1
  })
}
