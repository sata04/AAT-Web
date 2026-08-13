/**
 * The two API calls the admin console needs that `src/cloud/gateway.ts` does not yet expose.
 *
 * Everything else the console talks to — users, invitations, storage, quotas, the renderer's
 * circuit breaker — is already typed in the gateway and is imported from there. This module exists
 * for the two routes that arrived after those clients were written:
 *
 *  - `GET /api/v1/admin/audit` grew `targetOwnerUserId` and `crossUserOnly` filters, and its rows
 *    grew a `targetOwnerUserId` field, when the deployment became a shared workspace. The gateway's
 *    `listAuditLog` predates that, and "who has been reading my measurements?" cannot be asked
 *    without them — which `docs/cloud-data-model.md` names as the question the widening created.
 *  - `GET /api/v1/workspace/runs` is the team-wide run listing. `GET /api/v1/runs` is scoped to the
 *    caller by its WHERE clause and always will be, so an operator looking at "the deployment's
 *    experiments" cannot be served by it at all.
 *
 * ## Why this file repeats the gateway's request wrapper
 *
 * It should not have to. `gateway.ts` has exactly the right `request<T>()` — timeout, credentials,
 * the two error envelopes, 404 read as "this deployment has no cloud half" — and keeps it private.
 * Re-exporting it is a one-line change to a file this work is not allowed to touch, so the wrapper
 * is reproduced here instead, deliberately identically, and the duplication is called out in the
 * handover: the correct end state is one wrapper in the gateway that both modules import.
 *
 * What is *not* duplicated is the result type. Callers get `CloudOutcome<T>` from the gateway, so
 * every screen in this console handles one kind of outcome regardless of which module the call came
 * from.
 */

import { type ErrorCode, isErrorCode } from '@aat/shared'
import type { AdminUser, CloudErrorDetails, CloudOutcome, RunSummary } from '../cloud/gateway.ts'
import { listAdminUsers } from '../cloud/gateway.ts'

const API_BASE = '/api/v1'

/** Same as the gateway's: a hung fetch must not hold a screen's status forever. */
const REQUEST_TIMEOUT_MS = 15_000

const RETRYABLE: ReadonlySet<string> = new Set(['POSTER_BUSY', 'RATE_LIMITED', 'INTERNAL'])

function readErrorBody(
  body: unknown,
): { code: ErrorCode; message: string; details: CloudErrorDetails | undefined } | null {
  if (typeof body !== 'object' || body === null) return null
  const envelope = body as { code?: unknown; message?: unknown; details?: unknown; error?: unknown }
  const nested =
    typeof envelope.error === 'object' && envelope.error !== null
      ? (envelope.error as { code?: unknown; message?: unknown; details?: unknown })
      : null
  const code = isErrorCode(nested?.code) ? nested.code : isErrorCode(envelope.code) ? envelope.code : null
  const message =
    typeof nested?.message === 'string'
      ? nested.message
      : typeof envelope.message === 'string'
        ? envelope.message
        : null
  const rawDetails = nested?.details ?? envelope.details
  const details =
    typeof rawDetails === 'object' && rawDetails !== null && !Array.isArray(rawDetails)
      ? (rawDetails as CloudErrorDetails)
      : undefined
  if (code === null && message === null) return null
  return { code: code ?? 'INTERNAL', message: message ?? '', details }
}

async function request<T>(path: string, init: RequestInit): Promise<CloudOutcome<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    })

    if (response.ok) return { ok: true, value: (await response.json()) as T }

    let code: ErrorCode = 'INTERNAL'
    let message = `HTTP ${response.status}`
    let details: CloudErrorDetails | undefined
    try {
      const parsed = readErrorBody(await response.json())
      if (parsed !== null) {
        code = parsed.code
        if (parsed.message.length > 0) message = parsed.message
        details = parsed.details
      }
    } catch {
      // Keep the status-derived message.
    }

    if (response.status === 404) {
      return { ok: false, kind: 'unavailable', message: 'クラウド機能は利用できません。' }
    }

    return {
      ok: false,
      kind: 'error',
      code,
      message,
      retryable: RETRYABLE.has(code),
      ...(details === undefined ? {} : { details }),
    }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'クラウドへの接続がタイムアウトしました。'
        : 'クラウドに接続できません。'
    return { ok: false, kind: 'unavailable', message }
  } finally {
    clearTimeout(timeout)
  }
}

function queryString(params: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded.length === 0 ? '' : `?${encoded}`
}

/* ------------------------------------------------------------------------------------------- */
/* The audit log, with the owner-oriented filters                                               */
/* ------------------------------------------------------------------------------------------- */

export interface AdminAuditEntry {
  id: string
  actorUserId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  /**
   * The member whose work the action touched — present on every entry about an owned resource,
   * including the ordinary case where it equals the actor. `worker/services/audit.ts` explains why
   * it is not written only when it is interesting: an absence is not something a log can prove.
   */
  targetOwnerUserId: string | null
  ipAddress: string | null
  /** Free-form JSON, of unknown shape. Never rendered without `src/admin/audit.ts`. */
  details: unknown
  createdAt: string
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[]
  nextCursor: string | null
}

export interface AdminAuditQuery {
  limit?: number | undefined
  cursor?: string | undefined
  action?: string | undefined
  actorUserId?: string | undefined
  targetOwnerUserId?: string | undefined
  /** The route reads this as `value === 'true'`, so it is a string on the wire, not a boolean. */
  crossUserOnly?: 'true' | undefined
}

/** GET /api/v1/admin/audit. Requires `audit:read`. Newest first, keyset-paginated on the ULID. */
export function listAuditEntries(query: AdminAuditQuery = {}): Promise<CloudOutcome<AdminAuditPage>> {
  return request<AdminAuditPage>(`/admin/audit${queryString({ ...query })}`, { method: 'GET' })
}

/* ------------------------------------------------------------------------------------------- */
/* The team-wide run listing                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * A run as the team listing returns it: the caller's own shape plus whose it is.
 *
 * The owner is given twice, by id and by display name, and both are needed. The id is what
 * `ownerUserId=` filters on and what the storage report keys its rows by; the name is the only
 * human identity AAT has, since there is no email address (`worker/auth/identity.ts`).
 */
export interface WorkspaceRunSummary extends RunSummary {
  ownerUserId: string
  ownerDisplayName: string
}

export interface WorkspaceRunPage {
  runs: WorkspaceRunSummary[]
  nextCursor: string | null
}

export interface WorkspaceRunQuery {
  search?: string | undefined
  tag?: string | undefined
  from?: string | undefined
  to?: string | undefined
  ownerUserId?: string | undefined
  limit?: number | undefined
  cursor?: string | undefined
}

/**
 * GET /api/v1/workspace/runs — every member's runs, in one listing.
 *
 * Requires `analysis:read` **and** `workspace:read`, which a Viewer does not hold. Note what this
 * is not: it is not an administrative route and it serves no bytes. It is the ordinary member
 * listing widened to the team, which is why an administrator reaching a colleague's run through it
 * is recorded against the ordinary member routes rather than through a second `/admin` door.
 */
export function listWorkspaceRuns(query: WorkspaceRunQuery = {}): Promise<CloudOutcome<WorkspaceRunPage>> {
  return request<WorkspaceRunPage>(`/workspace/runs${queryString({ ...query })}`, { method: 'GET' })
}

/* ------------------------------------------------------------------------------------------- */
/* Two bounded aggregations the console needs and no single route answers                       */
/* ------------------------------------------------------------------------------------------- */

/** The `/admin/users` ceiling. Asking for more is a validation failure, not a bigger page. */
const ADMIN_USER_PAGE_LIMIT = 200

/**
 * Every member of the deployment, by following the cursor.
 *
 * The user table is the console's membership list and half the screens join against it — the
 * storage report labels its rows from it, the audit log's actor ids are resolved through it, the
 * run listing's owner filter is built from it. A *page* of members cannot serve any of those: a
 * storage row whose user happened to be on page two would appear with no name, and an owner filter
 * would silently omit half the team.
 *
 * So the pages are followed, and the walk is bounded rather than open. `maxPages` is the promise
 * this function makes to the browser: at most `maxPages × 200` rows and at most `maxPages`
 * requests, whatever the deployment holds. `complete` says which happened, and every caller shows
 * it — a list quietly truncated at a thousand members would be a list that answers "who is in this
 * deployment" incorrectly, which is worse than one that says it stopped counting.
 *
 * This deployment is one research group (`docs/cloud-data-model.md`), so five pages is roughly two
 * orders of magnitude of headroom over any real membership.
 */
export async function listAllAdminUsers(
  maxPages = 5,
): Promise<CloudOutcome<{ users: AdminUser[]; complete: boolean }>> {
  const users: AdminUser[] = []
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const outcome = await listAdminUsers({ limit: ADMIN_USER_PAGE_LIMIT, cursor })
    // A failure part-way through is a failure: half a membership list presented as the whole one is
    // exactly the silent-omission failure this function exists to avoid.
    if (!outcome.ok) return outcome
    users.push(...outcome.value.users)
    if (outcome.value.nextCursor === null) return { ok: true, value: { users, complete: true } }
    cursor = outcome.value.nextCursor
  }
  return { ok: true, value: { users, complete: false } }
}

export interface OwnerRunCount {
  count: number
  /** True when the walk hit its page bound, so `count` is a floor rather than a total. */
  truncated: boolean
}

/**
 * How many runs one member owns.
 *
 * There is no route that counts runs per user — `GET /admin/storage` counts objects and bytes, and
 * the run listings return rows — so this counts rows through the team gallery with
 * `ownerUserId=`, one page at a time, and stops. It is deliberately *not* fired for every row of
 * the user table: `maxPages × 100` requests per screen load would be the console generating more
 * load than the researchers it is watching. The users screen offers it per account, on demand.
 *
 * The result is honest about its bound. `truncated` means "at least this many", and the screen says
 * so with a plus sign rather than presenting a floor as a total.
 */
export async function countRunsForOwner(
  ownerUserId: string,
  maxPages = 5,
): Promise<CloudOutcome<OwnerRunCount>> {
  let count = 0
  let cursor: string | undefined
  for (let page = 0; page < maxPages; page += 1) {
    const outcome = await listWorkspaceRuns({ ownerUserId, limit: 100, cursor })
    if (!outcome.ok) return outcome
    count += outcome.value.runs.length
    if (outcome.value.nextCursor === null) return { ok: true, value: { count, truncated: false } }
    cursor = outcome.value.nextCursor
  }
  return { ok: true, value: { count, truncated: true } }
}
