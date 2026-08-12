#!/usr/bin/env node

/**
 * Fail the build well before the Worker bundle reaches Cloudflare's size limit.
 *
 * Cloudflare Workers Paid allows 10 MiB of *gzipped* script. Hitting that limit
 * during a deploy is a bad time to find out, and a bundle creeps upward one
 * dependency at a time without anyone noticing, so this measures the artefact
 * wrangler actually produces (`wrangler deploy --dry-run --outdir ...`) and
 * warns long before the ceiling.
 *
 * Usage: node scripts/check-worker-bundle-size.mjs <outdir>
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

/** Cloudflare's documented gzipped script-size limit on the Paid plan. */
const LIMIT_BYTES = 10 * 1024 * 1024
/** Print a warning past this share of the limit. */
const WARN_RATIO = 0.3
/** Fail past this share, leaving generous headroom to react. */
const FAIL_RATIO = 0.5

const outDir = process.argv[2]
if (!outDir) {
  console.error('usage: check-worker-bundle-size.mjs <outdir>')
  process.exit(2)
}

/** Every emitted JS/WASM file counts toward the script size. */
function collect(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...collect(path))
    else if (/\.(js|mjs|cjs|wasm)$/.test(entry.name)) found.push(path)
  }
  return found
}

let stats
try {
  stats = statSync(outDir)
} catch {
  console.error(`Worker bundle directory not found: ${outDir}`)
  console.error('Run `wrangler deploy --dry-run --outdir <dir>` first.')
  process.exit(2)
}
if (!stats.isDirectory()) {
  console.error(`Not a directory: ${outDir}`)
  process.exit(2)
}

const files = collect(outDir)
if (files.length === 0) {
  console.error(`No script files under ${outDir} — did the dry run emit anything?`)
  process.exit(2)
}

// Gzip each file separately. This slightly over-reports versus a single stream
// (no cross-file dictionary sharing), which is the safe direction for a guard.
let total = 0
const perFile = files.map((path) => {
  const size = gzipSync(readFileSync(path)).length
  total += size
  return { path, size }
})

perFile.sort((a, b) => b.size - a.size)
const asMiB = (bytes) => (bytes / 1024 / 1024).toFixed(2)
const share = total / LIMIT_BYTES

console.log(
  `Worker bundle: ${asMiB(total)} MiB gzipped (${(share * 100).toFixed(1)}% of the ${asMiB(LIMIT_BYTES)} MiB limit)`,
)
for (const file of perFile.slice(0, 5)) {
  console.log(`  ${asMiB(file.size).padStart(6)} MiB  ${file.path}`)
}

if (share >= FAIL_RATIO) {
  console.error(
    `::error::Worker bundle is ${(share * 100).toFixed(1)}% of the Cloudflare limit ` +
      `(threshold ${FAIL_RATIO * 100}%). Trim dependencies or move data out of the Worker.`,
  )
  process.exit(1)
}
if (share >= WARN_RATIO) {
  console.log(
    `::warning::Worker bundle is ${(share * 100).toFixed(1)}% of the Cloudflare limit ` +
      `(warning threshold ${WARN_RATIO * 100}%).`,
  )
}
