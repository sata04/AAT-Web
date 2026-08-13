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

import type { PosterPlotSpec } from '@aat/plot-spec'
import type { AnalysisConfig, Capability, EncodedScalar, Role } from '@aat/shared'
import { type ErrorCode, isErrorCode } from '@aat/shared'

const API_BASE = '/api/v1'

/** Better Auth owns this prefix entirely; see `worker/index.ts`. */
const AUTH_BASE = '/api/auth'

/** Requests are abandoned after this; a hung fetch must not hold a status forever. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The structured half of a taxonomy error.
 *
 * `ApiError.toPayload()` carries `details` alongside the code, and some of those
 * details are the only way a client can recover rather than merely report: a
 * `run_code_already_exists` refusal names the `runId` that already holds the run
 * code, which is what turns a second analysis of the same experiment from a dead
 * end into a revision of the run that exists. The type is deliberately
 * `unknown`-valued — the payload is server-shaped, and reading a field out of it
 * is a decision the caller makes explicitly.
 */
export type CloudErrorDetails = Readonly<Record<string, unknown>>

export type CloudOutcome<T> =
  | { ok: true; value: T }
  /** The cloud is not reachable or not configured. Not an error the user caused. */
  | { ok: false; kind: 'unavailable'; message: string }
  /** The API answered with a taxonomy error. */
  | {
      ok: false
      kind: 'error'
      code: ErrorCode
      message: string
      retryable: boolean
      details?: CloudErrorDetails
    }

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
    let details: CloudErrorDetails | undefined
    try {
      const parsed = readErrorBody(await response.json())
      if (parsed !== null) {
        code = parsed.code
        if (parsed.message.length > 0) message = parsed.message
        details = parsed.details
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

    return {
      ok: false,
      kind: 'error',
      code,
      message,
      retryable: RETRYABLE.has(code),
      ...(details === undefined ? {} : { details }),
    }
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
  /** A run's only grouping. Free-form, shared across the workspace, replaced wholesale on PATCH. */
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

/**
 * A row from the team-wide listing: everything `/runs` returns, plus whose run it is.
 *
 * The display name is the only human identity AAT holds — the address on the user record is
 * synthetic and non-routable (see worker/auth/identity.ts), so there is nothing else to show and
 * nothing here that could be mistaken for a way to contact somebody.
 */
export interface WorkspaceRunSummary extends RunSummary {
  ownerUserId: string
  ownerDisplayName: string
}

export interface WorkspaceRunListQuery extends RunListQuery {
  /** Narrow to one member's runs. */
  ownerUserId?: string | undefined
}

export interface WorkspaceRunListPage {
  runs: WorkspaceRunSummary[]
  nextCursor: string | null
}

/**
 * Every member's runs, the caller's own included — `GET /api/v1/workspace/runs`.
 *
 * A separate call rather than a flag on {@link listRuns} because it is a separate route, and it is
 * a separate route because the authorization differs: it requires `workspace:read`, which a Viewer
 * does not hold. A Viewer calling this gets a refusal, which is the honest answer — folding the
 * two together would have meant answering them with a silently narrowed list they could not tell
 * apart from the team having no runs.
 */
export function listWorkspaceRuns(
  query: WorkspaceRunListQuery = {},
): Promise<CloudOutcome<WorkspaceRunListPage>> {
  return request<WorkspaceRunListPage>(`/workspace/runs${queryString({ ...query })}`, {
    method: 'GET',
  })
}

/**
 * What `POST /api/v1/runs` accepts.
 *
 * `runCode` is optional because the Worker derives it from `originalFilename`
 * when the filename follows the `YYMMDD[a-z]?_data.csv` convention, which is
 * where these researchers actually encode run identity. It is *present* in the
 * type because a file that does not follow the convention can still be recorded
 * — the alternative would be a researcher unable to store an experiment because
 * of how a file was named.
 */
export interface RunCreateRequest {
  originalFilename: string
  runCode?: string | undefined
  /** `YYYY-MM-DD`. Derived from the filename when it parses. */
  experimentDate?: string | undefined
  memo?: string | undefined
  tags?: readonly string[] | undefined
}

export interface CreatedRun {
  id: string
  runCode: string
  experimentDate: string | null
}

/**
 * POST /api/v1/runs — record that an experiment happened.
 *
 * A run is one physical drop of the capsule, so this is **not** idempotent the
 * way revision creation is: a second call with a run code the caller already
 * owns is refused with `INVALID_ANALYSIS_CONFIG` and
 * `details.reason === 'run_code_already_exists'`, carrying `details.runId`. That
 * is the recovery path a client wants — re-analysing yesterday's file is a new
 * *revision* of the run that exists, never a second run — which is why
 * `CloudOutcome` carries `details` at all.
 */
export function createRun(body: RunCreateRequest): Promise<CloudOutcome<{ run: CreatedRun }>> {
  return request<{ run: CreatedRun }>('/runs', { method: 'POST', ...jsonBody(body) })
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
 * PATCH /api/v1/runs/:runId — the memo and the tags, which is everything a run
 * carries that a reader may change.
 *
 * `tags` is replaced wholesale rather than diffed, which is what the route
 * does: the client sends the set it wants, so there is no ordering question
 * between an add and a remove that arrive together.
 */
export interface RunPatch {
  memo?: string | null | undefined
  tags?: readonly string[] | undefined
}

export function updateRun(runId: string, patch: RunPatch): Promise<CloudOutcome<{ ok: true }>> {
  return request<{ ok: true }>(`/runs/${id(runId)}`, { method: 'PATCH', ...jsonBody(patch) })
}

/** DELETE /api/v1/runs/:runId — soft-deletes the metadata, hard-deletes the bytes. */
export function deleteRun(runId: string): Promise<CloudOutcome<{ ok: true; objectsDeleted: number }>> {
  return request<{ ok: true; objectsDeleted: number }>(`/runs/${id(runId)}`, { method: 'DELETE' })
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
 * The headline numbers denormalised out of the snapshot, one row per revision.
 *
 * Scalars travel as `@aat/shared`'s `EncodedScalar` — a number, or one of the
 * tags `'NaN'`, `'Infinity'`, `'-Infinity'`, `'-0'` — because those four values
 * have no JSON spelling and a window statistic that quietly became `null` (or,
 * worse, `0` instead of `-0`) is a changed measurement, not a formatting
 * detail.
 */
export interface RevisionMetrics {
  windowSize: EncodedScalar
  inner: { mean: EncodedScalar | null; std: EncodedScalar | null; startTime: EncodedScalar | null }
  drag: { mean: EncodedScalar | null; std: EncodedScalar | null; startTime: EncodedScalar | null }
  innerSampleCount: number
  dragSampleCount: number
  warningCount: number
  gQuality?:
    | ReadonlyArray<{
        windowSize: number
        innerStartTime: EncodedScalar | null
        innerMean: EncodedScalar | null
        innerStd: EncodedScalar | null
        dragStartTime: EncodedScalar | null
        dragMean: EncodedScalar | null
        dragStd: EncodedScalar | null
      }>
    | undefined
}

export interface RevisionCreateRequest {
  sourceSha256: string
  configHash: string
  config: AnalysisConfig
  engineVersion: string
  appVersion?: string | undefined
  snapshotFormatVersion: number
  notes?: string | undefined
  metrics: RevisionMetrics
}

/**
 * POST /api/v1/runs/:runId/revisions — create the immutable analysis record.
 *
 * Idempotent by analysis identity: the same source bytes, configuration and
 * engine version are one analysis, so a retried request answers 200 with
 * `created: false` and the revision that already exists rather than minting a
 * second one. A double-clicked button, a flaky network and the same file
 * analysed on two devices all converge on one revision — which is what makes
 * calling this on every completed analysis safe.
 */
export function createRevision(
  runId: string,
  body: RevisionCreateRequest,
): Promise<CloudOutcome<{ revision: RevisionSummary; created: boolean }>> {
  return request<{ revision: RevisionSummary; created: boolean }>(`/runs/${id(runId)}/revisions`, {
    method: 'POST',
    ...jsonBody(body),
  })
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

/**
 * POST /api/v1/revisions/:revisionId/poster/auto — the automatic formal poster.
 *
 * Idempotent, and idempotent *in the database*: the partial unique index
 * `poster_figures_auto_unique (analysis_revision_id, preset_version) WHERE kind
 * = 'auto'` means the claiming `INSERT ... ON CONFLICT DO NOTHING` succeeds for
 * exactly one caller. Everyone else reads back the row that already exists. So
 * a double-submit, a reload halfway through the request and the same user on
 * two devices produce one poster and one render.
 *
 * Crucially, a repeat call after the figure is `ready` — or while it is
 * `rendering`, or after it has `failed` — renders *nothing* and answers 200
 * with `created: false`. That is what makes this endpoint safe to call again
 * after a dropped connection, and it is also why a failed figure has to be
 * retried through {@link retryPoster}: a client polling this endpoint cannot
 * turn a persistent renderer fault into a render loop.
 *
 * `spec.analysisRevisionId` MUST equal `revisionId` and `spec.posterKind` MUST
 * be `'auto'`; the Worker answers `INVALID_ANALYSIS_CONFIG` otherwise, because
 * filing a figure of one measurement under another is a provenance failure.
 * Build the spec with `@aat/plot-spec`'s `buildAutoPosterPlotSpec` and both hold
 * by construction.
 */
export function requestAutoPoster(
  revisionId: string,
  spec: PosterPlotSpec,
): Promise<CloudOutcome<{ poster: PosterFigure; created?: boolean }>> {
  return request<{ poster: PosterFigure; created?: boolean }>(`/revisions/${id(revisionId)}/poster/auto`, {
    method: 'POST',
    ...jsonBody({ spec }),
  })
}

/**
 * POST /api/v1/revisions/:revisionId/posters — a hand-configured figure.
 *
 * Deliberately **not** idempotent, and that is the point: a researcher adjusting
 * the axis bounds and rendering again is asking for a different picture each
 * time, so collapsing those onto one row would destroy the variant they just
 * made. Poster history is stored, never overwritten — the custom figures are
 * excluded from the automatic poster's uniqueness constraint by its
 * `WHERE kind = 'auto'` clause.
 *
 * `spec.posterKind` must be `'custom'`, which is what `buildPosterPlotSpec`
 * produces and the only kind it can produce.
 */
export function createCustomPoster(
  revisionId: string,
  spec: PosterPlotSpec,
): Promise<CloudOutcome<{ poster: PosterFigure }>> {
  return request<{ poster: PosterFigure }>(`/revisions/${id(revisionId)}/posters`, {
    method: 'POST',
    ...jsonBody({ spec }),
  })
}

/**
 * POST /api/v1/posters/:posterId/retry — re-attempt a figure that failed.
 *
 * The spec is sent again rather than replayed from storage, and its
 * `posterKind` must match the stored figure's. Only a `failed` or `queued`
 * figure may be claimed, and only by the request that wins the conditional
 * UPDATE, so a user pressing "retry" five times starts one render.
 */
export function retryPoster(
  posterId: string,
  spec: PosterPlotSpec,
): Promise<CloudOutcome<{ poster: PosterFigure }>> {
  return request<{ poster: PosterFigure }>(`/posters/${id(posterId)}/retry`, {
    method: 'POST',
    ...jsonBody({ spec }),
  })
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
/* Snapshot upload                                                            */
/* ------------------------------------------------------------------------- */

export interface SnapshotUploadResult {
  object: { id: string; byteSize: number }
  created: boolean
}

export interface SnapshotUploadQuery {
  /**
   * The exact byte length of `body`. Quota is *reserved* against this before
   * the bytes arrive, and the request body is then read with a hard cap set to
   * the reservation — so under-declaring does not buy free storage, it
   * truncates the upload and fails it.
   */
  declaredBytes: number
  /** Lowercase SHA-256 hex of `body`, checked while the Worker reads it and again by R2. */
  sha256: string
  format: 'json' | 'json.gz'
}

/**
 * PUT /api/v1/revisions/:revisionId/snapshot — attach the analytical record.
 *
 * The body is the encoded snapshot from `@aat/shared`'s `encodeSnapshot`,
 * gzipped; this layer only moves the bytes. Everything the Worker needs to
 * admit them travels as **query parameters** rather than headers, because the
 * quota reservation has to happen before the body is read and because R2 is
 * handed the digest so it verifies the write itself.
 *
 * Idempotent for a retry and only for a retry: re-uploading bytes with the same
 * `sha256` answers 200 with `created: false`, while *different* bytes for a
 * revision that already has a snapshot are refused with `SNAPSHOT_INVALID` and
 * `reason: 'revision_already_has_a_different_snapshot'`. A revision is
 * immutable, and so is its record.
 */
export function uploadSnapshot(
  revisionId: string,
  body: Uint8Array,
  query: SnapshotUploadQuery,
): Promise<CloudOutcome<SnapshotUploadResult>> {
  return request<SnapshotUploadResult>(`/revisions/${id(revisionId)}/snapshot${queryString({ ...query })}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/gzip' },
    // A `Uint8Array` is a legal `BodyInit` at runtime; the DOM lib types it as
    // `ArrayBufferView<ArrayBufferLike>`, which does not narrow to the
    // `BufferSource` the signature wants.
    body: body as unknown as BodyInit,
  })
}
