/// <reference path="../worker-configuration.d.ts" />

/**
 * Resolving the Worker's configuration from its bindings, and failing closed when it is absent.
 *
 * The rule this module exists to enforce: **nothing security-relevant is ever inferred from the
 * request.** The relying-party id, the trusted origins and the auth base URL all come from
 * secrets. Deriving them from the `Host` header instead — which is a client-supplied string —
 * would let anyone who can route a request at the Worker choose the RP ID a passkey ceremony runs
 * under, and an RP ID mismatch is not a soft failure: a credential registered under one RP ID is
 * never offered again under another. Getting this wrong looks exactly like every user
 * simultaneously losing their authenticator.
 *
 * So a missing secret is a startup error, not a default.
 */

import { ApiError } from '@aat/shared'

/** Everything the Worker needs that is not a binding object. Values are validated, not raw. */
export interface WorkerConfig {
  /** Better Auth's secret, used for session-cookie signing. */
  authSecret: string
  /** Absolute base URL of the deployment, e.g. https://aat.example.ac.jp */
  authBaseUrl: string
  /** WebAuthn relying-party id: a registrable domain suffix of the origin, e.g. aat.example.ac.jp */
  rpId: string
  /** Human-readable relying-party name shown by the authenticator during registration. */
  rpName: string
  /** Exact origins allowed to complete an auth ceremony. Compared by equality, never by suffix. */
  trustedOrigins: readonly string[]
  defaultQuotaBytes: number
  maxSnapshotBytes: number
  maxSourceBytes: number
  maxPosterBytes: number
  maxConcurrentRenders: number
  renderStaleSeconds: number
  reservationTtlSeconds: number
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

function requireSecret(env: Env, key: keyof Env & string): string {
  const value = env[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigurationError(
      `Required secret ${key} is missing. See wrangler.jsonc "secrets.required" and docs/deployment.md.`,
    )
  }
  return value.trim()
}

/**
 * Parse a numeric var. Vars arrive as strings even when they look like numbers in wrangler.jsonc,
 * and a typo there should stop the Worker rather than silently become NaN and disable a quota.
 */
function requireNumber(env: Env, key: keyof Env & string): number {
  const raw = env[key]
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Configuration var ${key} must be a positive number (got ${String(raw)}).`)
  }
  return parsed
}

/**
 * An RP ID is a domain, never an origin: "https://aat.example" and "aat.example:8788" are both
 * wrong, and both fail in a way that only shows up once a real authenticator is asked to sign.
 */
function assertValidRpId(rpId: string): void {
  if (rpId.includes('/') || rpId.includes(':') || rpId.includes(' ')) {
    throw new ConfigurationError(
      `AAT_RP_ID must be a bare domain such as "aat.example.ac.jp" (got "${rpId}"). ` +
        'It must not include a scheme, a port or a path.',
    )
  }
}

function parseTrustedOrigins(raw: string): readonly string[] {
  const origins = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (origins.length === 0) {
    throw new ConfigurationError('AAT_TRUSTED_ORIGINS must list at least one origin.')
  }
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new ConfigurationError(`AAT_TRUSTED_ORIGINS entry "${origin}" is not a valid URL.`)
    }
    // `new URL('https://x/y').origin` drops the path, so comparing the round trip is what rejects
    // an entry with a path or trailing slash — which would silently never match a real Origin
    // header and turn every ceremony into an opaque failure.
    if (parsed.origin !== origin) {
      throw new ConfigurationError(
        `AAT_TRUSTED_ORIGINS entry "${origin}" must be a bare origin (got origin "${parsed.origin}").`,
      )
    }
  }
  return Object.freeze(origins)
}

const CONFIG_CACHE = new WeakMap<Env, WorkerConfig>()

/**
 * Resolve and validate the configuration for this Worker instance.
 *
 * Cached per `env` object: an isolate handles many requests with the same `env`, and re-validating
 * on every one of them is pure waste. Throws {@link ConfigurationError} — never returns a
 * partially-populated config.
 */
export function resolveConfig(env: Env): WorkerConfig {
  const cached = CONFIG_CACHE.get(env)
  if (cached) return cached

  const rpId = requireSecret(env, 'AAT_RP_ID')
  assertValidRpId(rpId)

  const config: WorkerConfig = {
    authSecret: requireSecret(env, 'BETTER_AUTH_SECRET'),
    authBaseUrl: requireSecret(env, 'BETTER_AUTH_URL').replace(/\/+$/, ''),
    rpId,
    rpName: requireSecret(env, 'AAT_RP_NAME'),
    trustedOrigins: parseTrustedOrigins(requireSecret(env, 'AAT_TRUSTED_ORIGINS')),
    defaultQuotaBytes: requireNumber(env, 'AAT_DEFAULT_QUOTA_BYTES'),
    maxSnapshotBytes: requireNumber(env, 'AAT_MAX_SNAPSHOT_BYTES'),
    maxSourceBytes: requireNumber(env, 'AAT_MAX_SOURCE_BYTES'),
    maxPosterBytes: requireNumber(env, 'AAT_MAX_POSTER_BYTES'),
    maxConcurrentRenders: requireNumber(env, 'AAT_MAX_CONCURRENT_RENDERS'),
    renderStaleSeconds: requireNumber(env, 'AAT_RENDER_STALE_SECONDS'),
    reservationTtlSeconds: requireNumber(env, 'AAT_RESERVATION_TTL_SECONDS'),
  }

  CONFIG_CACHE.set(env, config)
  return config
}

/**
 * The application version reported in snapshots and audit entries. Bumped by hand alongside a
 * behavioural change, the same way the desktop app's `pyproject.toml` version invalidates caches.
 */
export const APP_VERSION = '1.0.0'

/** Thrown when a caller asks for a resource that exists but belongs to someone else. */
export function notFound(): ApiError {
  // Deliberately RESOURCE_NOT_FOUND rather than FORBIDDEN: telling an attacker "this id exists but
  // is not yours" is an existence oracle over other users' run codes.
  return new ApiError('RESOURCE_NOT_FOUND')
}
