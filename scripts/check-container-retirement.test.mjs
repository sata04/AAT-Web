import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('retirement preserves the deployed namespace without a Container or callable binding', () => {
  const config = readFileSync(new URL('../apps/web/wrangler.jsonc', import.meta.url), 'utf8')
  // This deliberately checks the one frozen historical stanza, not a general JSONC parser.
  assert.match(
    config,
    /"migrations":\s*\[\s*\{\s*"tag":\s*"v1",\s*"new_sqlite_classes":\s*\["PosterRendererContainer"\]\s*\}\s*\]/,
  )
  for (const key of ['containers', 'durable_objects', 'exports', 'deleted_classes']) {
    assert.doesNotMatch(config, new RegExp(`^\\s*"${key}"\\s*:`, 'm'))
  }
  const entry = readFileSync(new URL('../apps/web/worker/index.ts', import.meta.url), 'utf8')
  assert.match(entry, /export \{ PosterRendererContainer \} from '\.\/legacy-poster-renderer\.ts'/)
})
