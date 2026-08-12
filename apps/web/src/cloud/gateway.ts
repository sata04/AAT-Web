/**
 * The browser's side of the optional cloud API.
 *
 * Everything here is optional by construction. AAT Web is a local-first
 * analysis tool: if none of these calls ever succeeds — no account, no network,
 * a Worker that has not been deployed — the application still opens files,
 * analyses them, draws them and exports them. That is why every method resolves
 * to a *result* describing what happened rather than throwing, and why the
 * caller treats "unavailable" as a normal state.
 *
 * The endpoints are the versioned `/api/v1/*` surface described in
 * `docs/web-architecture.md`, plus Better Auth's own `/api/auth/*` prefix for
 * the one AAT-specific auth exchange (invitation redemption). Requests carry
 * credentials so Better Auth's session cookie is sent; responses are read
 * through the shared error taxonomy, so a `POSTER_BUSY` or a `QUOTA_EXCEEDED`
 * arrives as a code the UI can react to rather than as an HTTP number.
 *
 * Every response type below was derived by reading `worker/routes/*.ts` and
 * transcribing what the handler actually puts in `context.json(...)`. Where a
 * field is `string | null` here it is because the column is nullable there;
 * where a list has a `nextCursor` it is because the route does keyset
 * pagination on the ULID primary key. Nothing here is aspirational — a shape
 * the Worker does not produce would be worse than no client at all.
 */

import type { Capability, Role } from '@aat/shared'
import { type ErrorCode, isErrorCode } from '@aat/shared'

const API_BASE = '/api/v1'

/** Better Auth owns this prefix entirely; see `worker/index.ts`. */
const AUTH_BASE = '/api/auth'

/** Requests are abandoned after this; a hung fetch must not hold a status forever. */
const REQUEST_TIMEOUT_MS = 15_000

export type CloudOutcome<T> =
  | { ok: true; value: T }
  /** The cloud is not reachable or not configured. Not an error the user caused. */
  | { ok: false; kind: 'unavailable'; message: string }
  /** The API answered with a taxonomy error. */
  | { ok: false; kind: 'error'; code: ErrorCode; message: string; retryable: boolean }

/** Codes worth offering a retry for; the rest need a different action, not another try. */
const RETRYABLE: ReadonlySet<string> = new Set(['POSTER_BUSY', 'RATE_LIMITED', 'INTERNAL'])

/**
 * Read the taxonomy error out of a failure body.
 *
 * Two envelopes exist and both are legitimate. `worker/middleware/errors.ts`
 * nests the payload under `error` for everything on `/api/v1`; the passkey
 * plugin hands its payload to Better Auth's `APIError`, which serialises it at
 * the top level. Accepting both is what stops an `INVITE_EXPIRED` from arriving
 * at the registration screen as a bare "HTTP 410".
 */
function readErrorBody(body: unknown): { code: ErrorCode; message: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const envelope = body as { code?: unknown; message?: unknown; error?: unknown }
  const nested =
    typeof envelope.error === 'object' && envelope.error !== null
      ? (envelope.error as { code?: unknown; message?: unknown })
      : null
  const code = isErrorCode(nested?.code) ? nested.code : isErrorCode(envelope.code) ? envelope.code : null
  const message =
    typeof nested?.message === 'string'
      ? nested.message
      : typeof envelope.message === 'string'
        ? envelope.message
        : null
  if (code === null && message === null) return null
  return { code: code ?? 'INTERNAL', message: message ?? '' }
}

async function requestAt<T>(base: string, path: string, init: RequestInit): Promise<CloudOutcome<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    })

    if (response.ok) {
      const value = (await response.json()) as T
      return { ok: true, value }
    }

    // A body we cannot read is not a reason to lose the status code.
    let code: ErrorCode = 'INTERNAL'
    let message = `HTTP ${response.status}`
    try {
      const parsed = readErrorBody(await response.json())
      if (parsed !== null) {
        code = parsed.code
        if (parsed.message.length > 0) message = parsed.message
      }
    } catch {
      // Fall through with the status-derived message.
    }

    // 404 means this deployment has no cloud half at all, which is a supported
    // configuration rather than a failure to report. Unconditional, as the
    // original contract states — note the consequence: a run or user that
    // genuinely does not exist also answers `RESOURCE_NOT_FOUND` with 404, so a
    // detail screen sees `unavailable` for a missing resource too, and should
    // phrase that state as "not found or not available" rather than as an outage.
    if (response.status === 404) {
      return { ok: false, kind: 'unavailable', message: 'クラウド機能は利用できません。' }
    }

    return { ok: false, kind: 'error', code, message, retryable: RETRYABLE.has(code) }
  } catch (error) {
    // Offline, DNS failure, abort: all "the cloud is not there right now".
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'クラウドへの接続がタイムアウトしました。'
        : 'クラウドに接続できません。ローカルの解析結果はそのまま利用できます。'
    return { ok: false, kind: 'unavailable', message }
  } finally {
    clearTimeout(timeout)
  }
}

function request<T>(path: string, init: RequestInit): Promise<CloudOutcome<T>> {
  return requestAt<T>(API_BASE, path, init)
}

/**
 * The same taxonomy against Better Auth's prefix.
 *
 * Exported because `src/auth/invitation.ts` needs it and must not build a second
 * fetch wrapper with its own error handling — the invitation exchange is the one
 * request in this application whose failure path is security-relevant, and it
 * should not be the one place with bespoke plumbing.
 */
export function authRequest<T>(path: string, init: RequestInit): Promise<CloudOutcome<T>> {
  return requestAt<T>(AUTH_BASE, path, init)
}

function jsonBody(value: unknown): RequestInit {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }
}

/** Build a query string from the parameters that were actually supplied. */
function queryString(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded.length === 0 ? '' : `?${encoded}`
}

const id = encodeURIComponent

/* ------------------------------------------------------------------------- */
/* The caller's own account — GET /api/v1/me                                  */
/* ------------------------------------------------------------------------- */

export interface QuotaState {
  bytesUsed: number
  bytesReserved: number
  bytesLimit: number
  objectCount: number
}

/**
 * `email` is absent, and that is the point.
 *
 * `worker/auth/identity.ts` gives every user a synthetic `@aat.invalid` address
 * because the auth framework's data model demands one. It is not an identity and
 * is never returned by any route; the human identity is `displayName`.
 */
export interface MeResponse {
  user: { id: string; displayName: string; role: Role }
  capabilities: readonly Capability[]
  quota: QuotaState | null
}

/**
 * Who, if anyone, is signed in.
 *
 * Called once at start-up by the session provider. A negative answer puts the
 * app in local-only mode for that session, which is the default experience and
 * not a degraded one.
 */
export function fetchMe(): Promise<CloudOutcome<MeResponse>> {
  return request<MeResponse>('/me', { method: 'GET' })
}

export interface MyPasskey {
  id: string
  name: string | null
  deviceType: string
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

/** GET /api/v1/me/passkeys — the caller's own credentials, without public keys or counters. */
export function fetchMyPasskeys(): Promise<CloudOutcome<{ passkeys: MyPasskey[] }>> {
  return request<{ passkeys: MyPasskey[] }>('/me/passkeys', { method: 'GET' })
}

/**
 * DELETE /api/v1/me/passkeys/:id.
 *
 * Refuses the last passkey with `FORBIDDEN` and
 * `details.reason === 'cannot_delete_last_passkey'`. The UI disables the control
 * as well, but the server is the authority: with no password and no email, the
 * last credential is the account.
 */
export function deleteMyPasskey(passkeyId: string): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/me/passkeys/${id(passkeyId)}`, { method: 'DELETE' })
}

/* ------------------------------------------------------------------------- */
/* Runs — /api/v1/runs                                                        */
/* ------------------------------------------------------------------------- */

export interface RunSummary {
  id: string
  runCode: string
  experimentDate: string | null
  suffix: string
  originalFilename: string
  memo: string | null
  projectId: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

/**
 * The filters `GET /api/v1/runs` actually accepts.
 *
 * There is deliberately no `sort`: the route orders by `desc(runs.id)` and the
 * ids are ULIDs, so the listing is newest-first by creation and the cursor is a
 * stable page boundary even while runs are being created. Offering a sort
 * control the API cannot honour would be worse than offering none.
 */
export interface RunListQuery {
  /** Substring match against the run code and the original filename. */
  search?: string | undefined
  tag?: string | undefined
  projectId?: string | undefined
  /** Inclusive experiment-date bounds, `YYYY-MM-DD`. */
  from?: string | undefined
  to?: string | undefined
  /** 1–100; the route defaults to 25. */
  limit?: number | undefined
  /** The `nextCursor` of the previous page. */
  cursor?: string | undefined
}

export interface RunListPage {
  runs: RunSummary[]
  nextCursor: string | null
}

export function listRuns(query: RunListQuery = {}): Promise<CloudOutcome<RunListPage>> {
  return request<RunListPage>(`/runs${queryString({ ...query })}`, { method: 'GET' })
}

export interface RunRevisionSummary {
  id: string
  revisionNumber: number
  configHash: string
  engineVersion: string
  createdAt: string
}

export interface RunDetail {
  run: RunSummary
  revisions: RunRevisionSummary[]
}

/** GET /api/v1/runs/:runId — the run plus its revisions, oldest revision first. */
export function fetchRun(runId: string): Promise<CloudOutcome<RunDetail>> {
  return request<RunDetail>(`/runs/${id(runId)}`, { method: 'GET' })
}

/**
 * PATCH /api/v1/runs/:runId — memo, project and tags.
 *
 * `tags` is replaced wholesale rather than diffed, which is what the route
 * does: the client sends the set it wants, so there is no ordering question
 * between an add and a remove that arrive together.
 */
export interface RunPatch {
  memo?: string | null | undefined
  projectId?: string | null | undefined
  tags?: readonly string[] | undefined
}

export function updateRun(runId: string, patch: RunPatch): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/runs/${id(runId)}`, { method: 'PATCH', ...jsonBody(patch) })
}

/** DELETE /api/v1/runs/:runId — soft-deletes the metadata, hard-deletes the bytes. */
export function deleteRun(runId: string): Promise<CloudOutcome<{ ok: true; objectsDeleted: number }>> {
  return request<{ ok: true; objectsDeleted: number }>(`/runs/${id(runId)}`, { method: 'DELETE' })
}

export interface ProjectSummary {
  id: string
  name: string
  description: string | null
  createdAt: string
}

/** GET /api/v1/projects — the caller's unarchived projects, for the gallery's project filter. */
export function listProjects(): Promise<CloudOutcome<{ projects: ProjectSummary[] }>> {
  return request<{ projects: ProjectSummary[] }>('/projects', { method: 'GET' })
}

/* ------------------------------------------------------------------------- */
/* Analysis revisions — /api/v1/runs/:runId/revisions, /api/v1/revisions/:id  */
/* ------------------------------------------------------------------------- */

export interface RevisionSummary {
  id: string
  runId: string
  revisionNumber: number
  sourceSha256: string
  configHash: string
  engineVersion: string
  appVersion: string
  snapshotFormatVersion: number
  hasSnapshot: boolean
  notes: string | null
  createdAt: string
}

/** GET /api/v1/runs/:runId/revisions. */
export function listRevisions(runId: string): Promise<CloudOutcome<{ revisions: RevisionSummary[] }>> {
  return request<{ revisions: RevisionSummary[] }>(`/runs/${id(runId)}/revisions`, { method: 'GET' })
}

/**
 * The headline metrics stored alongside a revision.
 *
 * Scalars round-trip through JSON as either a number or one of `@aat/shared`'s
 * tags (`'NaN'`, `'Infinity'`, `'-Infinity'`, `'-0'`), because those four values
 * have no JSON spelling and silently becoming `null` would change the science.
 * `unknown` here is honest: the route re-parses stored JSON text and does not
 * re-validate it, so the caller decodes with `@aat/shared` rather than trusting
 * a structural type.
 */
export interface RevisionDetail {
  revision: RevisionSummary
  config: unknown
  metrics: {
    windowSize: unknown
    inner: { mean: unknown; std: unknown; startTime: unknown }
    drag: { mean: unknown; std: unknown; startTime: unknown }
    innerSampleCount: number
    dragSampleCount: number
    warningCount: number
    gQuality: unknown
  } | null
}

/** GET /api/v1/revisions/:revisionId. */
export function fetchRevision(revisionId: string): Promise<CloudOutcome<RevisionDetail>> {
  return request<RevisionDetail>(`/revisions/${id(revisionId)}`, { method: 'GET' })
}

/* ------------------------------------------------------------------------- */
/* Poster figures                                                             */
/* ------------------------------------------------------------------------- */

export interface PosterFigure {
  posterId: string
  analysisRevisionId: string
  kind: 'auto' | 'custom'
  presetVersion: string
  specHash: string
  status: 'queued' | 'rendering' | 'ready' | 'failed'
  rendererVersion: string | null
  failureCode: string | null
  attemptCount: number
  createdAt: string
}

/**
 * GET /api/v1/revisions/:revisionId/posters — every figure for a revision.
 *
 * This is also the only way to poll one: there is no `GET` for a single
 * poster's state, so "is it ready yet" is answered by re-listing and looking at
 * the figure by id.
 */
export function listPosters(revisionId: string): Promise<CloudOutcome<{ posters: PosterFigure[] }>> {
  return request<{ posters: PosterFigure[] }>(`/revisions/${id(revisionId)}/posters`, { method: 'GET' })
}

/**
 * The URL of a rendered poster's PNG.
 *
 * A URL rather than a fetch, because the bytes belong in an `<img src>`: the
 * route streams `image/png` through the Worker (there is no public R2 URL and no
 * signed-URL issuance, so ownership is checked on the way out), and pulling it
 * into a blob first would buy nothing but memory.
 */
export function posterImageUrl(posterId: string): string {
  return `${API_BASE}/posters/${id(posterId)}/image`
}

/* ------------------------------------------------------------------------- */
/* Administration — /api/v1/admin                                             */
/* ------------------------------------------------------------------------- */

export interface AdminUser {
  id: string
  displayName: string
  role: string
  banned: boolean
  createdAt: string
}

export interface CursorQuery {
  /** 1–200; the admin routes default to 50. */
  limit?: number | undefined
  cursor?: string | undefined
}

/** GET /api/v1/admin/users. Requires `user:manage`. */
export function listAdminUsers(
  query: CursorQuery = {},
): Promise<CloudOutcome<{ users: AdminUser[]; nextCursor: string | null }>> {
  return request<{ users: AdminUser[]; nextCursor: string | null }>(
    `/admin/users${queryString({ ...query })}`,
    {
      method: 'GET',
    },
  )
}

export interface AdminUserPatch {
  role?: Role | undefined
  banned?: boolean | undefined
  banReason?: string | null | undefined
}

/**
 * PATCH /api/v1/admin/users/:userId.
 *
 * Refuses a self-demotion or a self-ban with `FORBIDDEN`: an administrator who
 * removes their own privileges can leave a deployment with no administrator at
 * all, and there is no email-based recovery path to get one back.
 */
export function updateAdminUser(userId: string, patch: AdminUserPatch): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/admin/users/${id(userId)}`, { method: 'PATCH', ...jsonBody(patch) })
}

/** DELETE /api/v1/admin/users/:userId. Deletes the R2 objects before the row. */
export function deleteAdminUser(userId: string): Promise<CloudOutcome<{ ok: true; objectsDeleted: number }>> {
  return request<{ ok: true; objectsDeleted: number }>(`/admin/users/${id(userId)}`, { method: 'DELETE' })
}

export interface AdminPasskey {
  id: string
  deviceType: string
  backedUp: boolean
  createdAt: string
  lastUsedAt: string | null
}

/** GET /api/v1/admin/users/:userId/passkeys. */
export function listAdminUserPasskeys(userId: string): Promise<CloudOutcome<{ passkeys: AdminPasskey[] }>> {
  return request<{ passkeys: AdminPasskey[] }>(`/admin/users/${id(userId)}/passkeys`, { method: 'GET' })
}

/** DELETE /api/v1/admin/passkeys/:passkeyId — refused when it is the user's last one. */
export function deleteAdminPasskey(passkeyId: string): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/admin/passkeys/${id(passkeyId)}`, { method: 'DELETE' })
}

export interface InvitationRequest {
  kind: 'registration' | 'recovery'
  role: Role
  displayName: string
  note?: string | undefined
  /** Required for a recovery invitation: the existing user regaining access. */
  targetUserId?: string | undefined
  /** 1 hour to 14 days. */
  ttlHours: number
}

export interface IssuedInvitation {
  id: string
  expiresAt: string
  /**
   * Shown exactly once. It is not stored anywhere in plaintext and cannot be
   * retrieved again; a lost token means issuing a new invitation. Treat it the
   * way `src/auth/invitation.ts` treats the redemption side — never logged,
   * never persisted, never put in an error message.
   */
  token: string
}

/** POST /api/v1/admin/invitations. Requires `invitation:manage`; rate-limited per admin. */
export function createInvitation(
  body: InvitationRequest,
): Promise<CloudOutcome<{ invitation: IssuedInvitation }>> {
  return request<{ invitation: IssuedInvitation }>('/admin/invitations', {
    method: 'POST',
    ...jsonBody(body),
  })
}

export interface InvitationSummary {
  id: string
  kind: 'registration' | 'recovery'
  role: string
  displayName: string
  note: string | null
  status: string
  targetUserId: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  revokedAt: string | null
}

/** GET /api/v1/admin/invitations. Carries no token and no token hash, by design. */
export function listInvitations(
  query: CursorQuery = {},
): Promise<CloudOutcome<{ invitations: InvitationSummary[]; nextCursor: string | null }>> {
  return request<{ invitations: InvitationSummary[]; nextCursor: string | null }>(
    `/admin/invitations${queryString({ ...query })}`,
    { method: 'GET' },
  )
}

/** POST /api/v1/admin/invitations/:invitationId/revoke. */
export function revokeInvitation(invitationId: string): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/admin/invitations/${id(invitationId)}/revoke`, { method: 'POST' })
}

export interface StorageReport {
  perUser: Array<{
    userId: string
    displayName: string
    role: string
    bytesUsed: number
    bytesReserved: number
    bytesLimit: number
    objectCount: number
  }>
  totals: { objects: number; bytes: number; runs: number; revisions: number }
}

/** GET /api/v1/admin/storage. Requires `quota:manage`. Metadata only — never snapshot bytes. */
export function fetchStorageReport(): Promise<CloudOutcome<StorageReport>> {
  return request<StorageReport>('/admin/storage', { method: 'GET' })
}

/** PUT /api/v1/admin/quotas/:userId — refused when the new limit is below current usage. */
export function setUserQuota(
  userId: string,
  bytesLimit: number,
): Promise<CloudOutcome<{ quota: QuotaState }>> {
  return request<{ quota: QuotaState }>(`/admin/quotas/${id(userId)}`, {
    method: 'PUT',
    ...jsonBody({ bytesLimit }),
  })
}

export interface CircuitBreakerState {
  /** True when the renderer is disabled and no container call may be made. */
  open: boolean
  reason: string | null
  updatedAt: string | null
}

/** GET /api/v1/admin/renderer. */
export function fetchRendererBreaker(): Promise<CloudOutcome<{ circuitBreaker: CircuitBreakerState }>> {
  return request<{ circuitBreaker: CircuitBreakerState }>('/admin/renderer', { method: 'GET' })
}

/** PUT /api/v1/admin/renderer — the poster renderer's kill switch. */
export function setRendererBreaker(
  open: boolean,
  reason: string | null,
): Promise<CloudOutcome<{ circuitBreaker: CircuitBreakerState }>> {
  return request<{ circuitBreaker: CircuitBreakerState }>('/admin/renderer', {
    method: 'PUT',
    ...jsonBody({ open, reason }),
  })
}

export interface AuditEntry {
  id: string
  actorUserId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  ipAddress: string | null
  details: unknown
  createdAt: string
}

export interface AuditQuery extends CursorQuery {
  action?: string | undefined
  actorUserId?: string | undefined
}

/** GET /api/v1/admin/audit. Requires `audit:read`. Newest first. */
export function listAuditLog(
  query: AuditQuery = {},
): Promise<CloudOutcome<{ entries: AuditEntry[]; nextCursor: string | null }>> {
  return request<{ entries: AuditEntry[]; nextCursor: string | null }>(
    `/admin/audit${queryString({ ...query })}`,
    { method: 'GET' },
  )
}

/* ------------------------------------------------------------------------- */
/* Snapshot upload and the automatic poster                                   */
/* ------------------------------------------------------------------------- */

export interface SnapshotUploadResult {
  revisionId: string
}

/**
 * Persist an analysis revision.
 *
 * The body is a gzipped snapshot produced by `@aat/shared`'s
 * `encodeSnapshot`/`gzipCompress`; this layer only moves the bytes. Retrying
 * with the same `sourceSha256` and `configHash` is safe — the server keys the
 * revision on them, so a double-submit does not create two.
 *
 * KNOWN MISMATCH: no `/api/v1/analyses` route exists. The Worker's real path is
 * three calls — `POST /runs`, `POST /runs/:runId/revisions`, then
 * `PUT /revisions/:revisionId/snapshot?declaredBytes=…&sha256=…&format=json.gz`
 * — and reworking `src/cloud/sync.ts` around that is a separate change with its
 * own quota-reservation semantics. Left as-is so the analyzer's behaviour is
 * unchanged; the sync lane reports the failure and the local analysis is
 * untouched, which is exactly the independence the status model promises.
 */
export function uploadSnapshot(
  body: Uint8Array,
  headers: { sourceSha256: string; configHash: string; filename: string },
): Promise<CloudOutcome<SnapshotUploadResult>> {
  return request<SnapshotUploadResult>('/analyses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'X-AAT-Source-Sha256': headers.sourceSha256,
      'X-AAT-Config-Hash': headers.configHash,
      // Encoded, because a Japanese filename is not a legal header value raw.
      'X-AAT-Filename': encodeURIComponent(headers.filename),
    },
    body: body as unknown as BodyInit,
  })
}

export interface PosterState {
  status: 'queued' | 'rendering' | 'ready' | 'failed'
  url?: string
  message?: string
}

/**
 * Ask for the automatic formal poster for a revision.
 *
 * Idempotent by contract: exactly one poster exists per
 * `(analysisRevisionId, autoPosterPresetVersion)`, enforced in the database, so
 * calling this again after a dropped connection returns the existing one rather
 * than starting a second render.
 *
 * KNOWN MISMATCH, as above: the Worker's route is
 * `POST /api/v1/revisions/:revisionId/poster/auto` and it requires a validated
 * `@aat/plot-spec` document in the body, which this application has no builder
 * for yet.
 */
export function requestPoster(revisionId: string): Promise<CloudOutcome<PosterState>> {
  return request<PosterState>(`/analyses/${id(revisionId)}/poster`, { method: 'POST' })
}

/** Poll a poster's state. Used while it is queued or rendering. */
export function fetchPoster(revisionId: string): Promise<CloudOutcome<PosterState>> {
  return request<PosterState>(`/analyses/${id(revisionId)}/poster`, { method: 'GET' })
}
