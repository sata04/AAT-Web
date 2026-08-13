/**
 * The cloud calls the Run Gallery needs that `src/cloud/gateway.ts` does not have.
 *
 * The gateway is owned elsewhere and covers almost everything these screens need — `listRuns`,
 * `fetchRun`, `updateRun`, `deleteRun`, `listRevisions`, `fetchRevision`, `listPosters`,
 * `posterImageUrl`, `listProjects`, and the three poster render calls. What it has no entry point
 * for is the two responses that are **bulk bytes rather than JSON**: the snapshot that makes a
 * stored run reopenable, and the original-CSV backup. Only those live here, and they live here
 * rather than as edits to gateway.ts so two concurrent changes to the cloud layer cannot collide
 * in one file.
 *
 * Two things in this module deliberately differ from the gateway, and each difference is the point
 * of it existing:
 *
 *  - **Bytes, not JSON.** A snapshot is up to 16 MiB (`AAT_MAX_SNAPSHOT_BYTES`) of base64-heavy
 *    JSON, possibly gzipped; a source CSV is up to 32 MiB. Neither fits the gateway's
 *    "`await response.json()` within 15 seconds" shape, so the request helper here takes a reader
 *    and a per-call timeout instead of assuming both.
 *
 *  - **404 is not blanket "unavailable".** The gateway maps every 404 to `unavailable` because it
 *    cannot tell a deployment with no Worker from a missing row, and for its callers the
 *    distinction does not change what to offer. Here it does: `GET /runs/:id/source` answering 404
 *    is the *answer* — this run has no original-CSV backup — and reporting that as an outage would
 *    tell a researcher their cloud is down when in fact their file was never uploaded. So a 404
 *    that carries a parseable taxonomy body keeps its code, and only a 404 with no body at all
 *    (the shape a deployment with no `/api/v1` produces) becomes `unavailable`.
 *
 * Neither call here can start a container render. Both are GETs of objects that already exist.
 */

import { type ErrorCode, isErrorCode } from '@aat/shared'
import type { CloudOutcome } from '../cloud/gateway.ts'

const API_BASE = '/api/v1'

/**
 * Bulk-object calls.
 *
 * A snapshot is capped at 16 MiB and a source CSV at 32 MiB, and both are streamed through the
 * Worker from private R2 rather than from a CDN edge. Fifteen seconds is a reasonable ceiling for
 * a metadata round trip and an unreasonable one for tens of megabytes on a conference network, so
 * these get their own budget — long enough to finish, still bounded so a dead connection does not
 * leave the screen saying "読み込み中" forever.
 */
const OBJECT_TIMEOUT_MS = 120_000

/** Codes worth offering a retry for; the rest need a different action, not another try. */
const RETRYABLE: ReadonlySet<string> = new Set(['POSTER_BUSY', 'RATE_LIMITED', 'INTERNAL'])

/**
 * Read the taxonomy error out of a failure body.
 *
 * `worker/middleware/errors.ts` nests every `/api/v1` payload under `error`. The top-level form is
 * accepted too because Better Auth's `APIError` serialises there, and a helper that only
 * understood one of the two would turn a real code into a bare HTTP number at exactly the moment
 * the code was the useful part.
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

interface SendOptions<T> {
  timeoutMs: number
  /** How to turn a successful response into the value. Bytes, a blob, or JSON. */
  read: (response: Response) => Promise<T>
}

async function send<T>(path: string, init: RequestInit, options: SendOptions<T>): Promise<CloudOutcome<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    })

    if (response.ok) return { ok: true, value: await options.read(response) }

    let parsed: { code: ErrorCode; message: string } | null = null
    try {
      parsed = readErrorBody(await response.json())
    } catch {
      // A body that is not JSON tells us only that this is not the AAT API answering.
    }

    // See the module doc: only a bodyless 404 means "there is no cloud half here".
    if (parsed === null && response.status === 404) {
      return { ok: false, kind: 'unavailable', message: 'クラウド機能は利用できません。' }
    }

    const code = parsed?.code ?? 'INTERNAL'
    const message = parsed !== null && parsed.message.length > 0 ? parsed.message : `HTTP ${response.status}`
    return { ok: false, kind: 'error', code, message, retryable: RETRYABLE.has(code) }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? 'クラウドへの接続がタイムアウトしました。'
        : 'クラウドに接続できません。ローカルの解析結果はそのまま利用できます。'
    return { ok: false, kind: 'unavailable', message }
  } finally {
    clearTimeout(timeout)
  }
}

const id = encodeURIComponent

/* ------------------------------------------------------------------------- */
/* Snapshots — the bytes that make a stored run reopenable                    */
/* ------------------------------------------------------------------------- */

/**
 * `GET /api/v1/revisions/:revisionId/snapshot`.
 *
 * Returns the stored bytes exactly as R2 holds them, which may be gzip and may be plain JSON: the
 * upload route stores `snapshots/<user>/<run>/<revision>.json` or `.json.gz` depending on the
 * `format` parameter, but records `content_type: application/json` for both and streams the object
 * with no `content-encoding` header. So the response's own headers cannot tell the two apart, and
 * neither can the revision row — `snapshot_format_version` describes the document, not its
 * container. `decodeSnapshotBytes` in `./replay.ts` therefore sniffs the gzip magic number, which
 * is the one signal that is actually present. See the report's backend-gap note.
 */
export function fetchSnapshotBytes(revisionId: string): Promise<CloudOutcome<Uint8Array>> {
  return send<Uint8Array>(
    `/revisions/${id(revisionId)}/snapshot`,
    { method: 'GET' },
    {
      timeoutMs: OBJECT_TIMEOUT_MS,
      read: async (response) => new Uint8Array(await response.arrayBuffer()),
    },
  )
}

/* ------------------------------------------------------------------------- */
/* Original-source CSV backup                                                 */
/* ------------------------------------------------------------------------- */

export interface SourceBackupDownload {
  blob: Blob
  /** From `content-disposition`, which the Worker RFC 5987-encodes so a Japanese name survives. */
  filename: string | null
}

/**
 * Parse the filename out of a `content-disposition` header.
 *
 * Only the `filename*=UTF-8''…` form is read, because that is the only form `streamObject` writes.
 * A malformed percent-escape yields `null` rather than throwing: a download whose name could not
 * be read is still a download, and the caller has the run's own filename to fall back on.
 */
function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const match = /filename\*=UTF-8''([^;]+)/i.exec(header)
  const encoded = match?.[1]
  if (encoded === undefined) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

/**
 * `GET /api/v1/runs/:runId/source` — download the original CSV, if one was ever backed up.
 *
 * A run with no backup answers `RESOURCE_NOT_FOUND`, and this function passes that through as an
 * error code rather than as an outage, so the caller can say "バックアップはありません" instead of
 * "クラウドに接続できません".
 *
 * There is no cheaper way to ask. The Worker exposes no HEAD, no existence check and no listing of
 * `cloud_objects`, so "does this run have a source backup?" can only be answered by starting the
 * download — which is also audited as `source.download`. That is why the gallery card and the
 * detail screen show the backup as *未確認* until the user asks for it: inventing a status by
 * firing an audited download nobody requested would put a false entry in the security record to
 * fill in a badge.
 */
export function downloadSourceBackup(runId: string): Promise<CloudOutcome<SourceBackupDownload>> {
  return send<SourceBackupDownload>(
    `/runs/${id(runId)}/source`,
    { method: 'GET' },
    {
      timeoutMs: OBJECT_TIMEOUT_MS,
      read: async (response) => ({
        blob: await response.blob(),
        filename: filenameFromDisposition(response.headers.get('content-disposition')),
      }),
    },
  )
}
