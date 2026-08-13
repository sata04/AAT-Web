/**
 * Writes a deploy-time copy of `wrangler.jsonc` with the two account-scoped values filled in.
 *
 * ## Why this exists
 *
 * Five of the seven things a deployment needs are Worker secrets, and those come from Doppler
 * cleanly: the deploy job reads them into an allowlisted JSON file and `wrangler deploy
 * --secrets-file` ships them with the code. The other two are not secrets and cannot travel that
 * way — they are structural fields of the configuration file itself:
 *
 *   - `d1_databases[0].database_id`, printed by `wrangler d1 create`
 *   - `containers[0].image`, whose registry path embeds the account id, and whose digest is only
 *     known after the image is pushed
 *
 * Wrangler performs no variable substitution inside its configuration file — verified against the
 * current documentation, not assumed — so `${CLOUDFLARE_ACCOUNT_ID}` in that file would be sent
 * literally. The committed file therefore keeps deliberately invalid placeholders, which is the
 * right default (a mistaken deploy fails loudly instead of writing into some other account), and
 * this script produces the real configuration at deploy time from values Doppler holds.
 *
 * ## Why string replacement rather than parsing
 *
 * `wrangler.jsonc` is JSONC: it carries the comments that explain why `max_instances` is 1 and why
 * the RP ID is a secret. Parsing and re-serialising would discard all of it, and the file that
 * actually gets deployed should be the file a reviewer read. Each replacement asserts it matched
 * exactly once, so a rename or an edit that moves a placeholder fails here rather than silently
 * deploying the wrong thing.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PLACEHOLDER_DATABASE_ID = '00000000-0000-0000-0000-000000000000'
const PLACEHOLDER_ACCOUNT_IMAGE = 'registry.cloudflare.com/00000000000000000000000000000000/aat-poster-renderer:latest'

const outputPath = process.argv[2]
if (!outputPath) {
  console.error('usage: node scripts/resolve-wrangler-config.mjs <output-path>')
  process.exit(1)
}

/** Read a required value, failing with the name so an operator knows which Doppler key is missing. */
function required(name) {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    console.error(`::error::${name} is unset. It must come from Doppler — see docs/deployment.md.`)
    process.exit(1)
  }
  return value.trim()
}

const databaseId = required('AAT_D1_DATABASE_ID')
const posterImage = required('POSTER_RENDERER_IMAGE')

/**
 * Replace exactly one occurrence, or fail.
 *
 * A zero-match means the committed file changed and this script is now filling in nothing — the
 * failure mode that would otherwise deploy a placeholder. A multi-match means the value appears
 * somewhere this script does not understand, and guessing which one to replace is not something a
 * deploy step should do.
 */
function replaceExactlyOnce(source, needle, replacement, label) {
  const occurrences = source.split(needle).length - 1
  if (occurrences !== 1) {
    console.error(
      `::error::expected exactly one ${label} placeholder in wrangler.jsonc, found ${occurrences}. ` +
        'The committed configuration changed; update scripts/resolve-wrangler-config.mjs to match.',
    )
    process.exit(1)
  }
  return source.replace(needle, replacement)
}

const configPath = join(import.meta.dirname, '..', 'wrangler.jsonc')
let config = readFileSync(configPath, 'utf8')

config = replaceExactlyOnce(config, PLACEHOLDER_DATABASE_ID, databaseId, 'D1 database id')
config = replaceExactlyOnce(config, PLACEHOLDER_ACCOUNT_IMAGE, posterImage, 'container image')

writeFileSync(outputPath, config)

// The image reference carries a digest and the database id is not a secret, but neither is printed:
// the deployment's account id is derivable from both, and this log is public on a public repository.
console.log(`resolve-wrangler-config: wrote ${outputPath} with the D1 id and container image filled in`)
