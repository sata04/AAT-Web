import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const appRequire = createRequire(new URL('../apps/web/package.json', import.meta.url))
const authRequire = createRequire(appRequire.resolve('better-auth'))
// The pool exports only an ESM entry. Resolve its installed package root
// without importing the pool or starting Workers just to inspect its Zod.
const poolRequire = createRequire(
  realpathSync(
    new URL('../apps/web/node_modules/@cloudflare/vitest-pool-workers/package.json', import.meta.url),
  ),
)
const consumers = [
  ['application', appRequire],
  ['Better Auth core', createRequire(authRequire.resolve('@better-auth/core'))],
  ['Workers test tooling', poolRequire],
]

// GHSA-mrhx-c7xc-m3w5: check each consumer's actual Zod resolution, since
// upgrading the direct dependency alone leaves vulnerable transitive copies.
for (const [consumer, require] of consumers) {
  test(`${consumer}: oversized arrays fail before element validation`, () => {
    const { z } = require('zod')
    let visits = 0
    const schema = z
      .array(
        z.number().refine(() => {
          visits += 1
          return true
        }),
      )
      .max(1)

    const oversized = schema.safeParse([1, 2])
    assert.equal(oversized.success, false)
    assert.equal(oversized.error.issues[0].code, 'too_big')
    assert.equal(visits, 0)

    assert.equal(schema.safeParse([1]).success, true)
    assert.equal(visits, 1)
  })
}
