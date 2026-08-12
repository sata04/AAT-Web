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
 * `docs/web-architecture.md`. Requests carry credentials so Better Auth's
 * session cookie is sent; responses are read through the shared error taxonomy,
 * so a `POSTER_BUSY` or a `QUOTA_EXCEEDED` arrives as a code the UI can react to
 * rather than as an HTTP number.
 */

import { type ErrorCode, isErrorCode } from '@aat/shared'

const API_BASE = '/api/v1'

/** Requests are abandoned after this; a hung fetch must not hold a status forever. */
const REQUEST_TIMEOUT_MS = 15_000

export interface CloudSession {
  userId: string
  displayName: string
  role: string
}

export type CloudOutcome<T> =
  | { ok: true; value: T }
  /** The cloud is not reachable or not configured. Not an error the user caused. */
  | { ok: false; kind: 'unavailable'; message: string }
  /** The API answered with a taxonomy error. */
  | { ok: false; kind: 'error'; code: ErrorCode; message: string; retryable: boolean }

/** Codes worth offering a retry for; the rest need a different action, not another try. */
const RETRYABLE: ReadonlySet<string> = new Set(['POSTER_BUSY', 'RATE_LIMITED', 'INTERNAL'])

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

    if (response.ok) {
      const value = (await response.json()) as T
      return { ok: true, value }
    }

    // A body we cannot read is not a reason to lose the status code.
    let code: ErrorCode = 'INTERNAL'
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { code?: unknown; message?: unknown }
      if (isErrorCode(body.code)) code = body.code
      if (typeof body.message === 'string') message = body.message
    } catch {
      // Fall through with the status-derived message.
    }

    // 404 on the versioned API means this deployment has no cloud half at all,
    // which is a supported configuration rather than a failure to report.
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

/**
 * Who, if anyone, is signed in.
 *
 * Called once at start-up. A negative answer puts the app in local-only mode
 * permanently for that session, which is the default experience and not a
 * degraded one.
 */
export function fetchSession(): Promise<CloudOutcome<CloudSession | null>> {
  return request<CloudSession | null>('/session', { method: 'GET' })
}

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
 */
export function requestPoster(revisionId: string): Promise<CloudOutcome<PosterState>> {
  return request<PosterState>(`/analyses/${encodeURIComponent(revisionId)}/poster`, { method: 'POST' })
}

/** Poll a poster's state. Used while it is queued or rendering. */
export function fetchPoster(revisionId: string): Promise<CloudOutcome<PosterState>> {
  return request<PosterState>(`/analyses/${encodeURIComponent(revisionId)}/poster`, { method: 'GET' })
}
