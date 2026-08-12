/// <reference path="../../worker-configuration.d.ts" />

/**
 * R2 object storage.
 *
 * ## Keys are built, never accepted
 *
 * Every key component is an identifier this server generated — a user id, a run id, a revision id,
 * an object id — and {@link assertKeySegment} refuses anything that is not one. An original
 * filename is *metadata*, stored in `cloud_objects.original_filename`, and never appears in a key.
 * A user-supplied name in an object key is a path-traversal primitive ("../../other-user/..."), a
 * collision primitive, and a way to smuggle content into a key namespace that authorization
 * decisions are made from.
 *
 * Layout:
 *   snapshots/<user>/<run>/<revision>.<fmt>
 *   posters/<user>/<run>/<revision>/<poster>.png
 *   sources/<user>/<run>/<object>.csv
 *
 * The user id leading every key is deliberate: it makes an accidental cross-tenant read visible as
 * a mismatch between the key and the caller, rather than something only the database could catch.
 *
 * ## The bucket is private
 *
 * There is no public bucket URL and no presigned-URL issuance. Every read goes through the Worker,
 * which checks ownership first and then streams `object.body` straight to the client — the bytes
 * are never buffered in the isolate on the way out.
 */

import { ApiError, sha256Hex } from '@aat/shared'

const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Guard every key component. A segment that is not a generated identifier is a bug, loudly. */
function assertKeySegment(segment: string, label: string): string {
  if (!KEY_SEGMENT_PATTERN.test(segment)) {
    throw new ApiError('INTERNAL', { cause: new Error(`Refusing to build an R2 key from ${label}`) })
  }
  return segment
}

export type SnapshotFormat = 'json' | 'json.gz'

export function snapshotKey(
  userId: string,
  runId: string,
  revisionId: string,
  format: SnapshotFormat,
): string {
  return [
    'snapshots',
    assertKeySegment(userId, 'user id'),
    assertKeySegment(runId, 'run id'),
    `${assertKeySegment(revisionId, 'revision id')}.${format}`,
  ].join('/')
}

export function posterKey(userId: string, runId: string, revisionId: string, posterId: string): string {
  return [
    'posters',
    assertKeySegment(userId, 'user id'),
    assertKeySegment(runId, 'run id'),
    assertKeySegment(revisionId, 'revision id'),
    `${assertKeySegment(posterId, 'poster id')}.png`,
  ].join('/')
}

export function sourceKey(userId: string, runId: string, objectId: string): string {
  return [
    'sources',
    assertKeySegment(userId, 'user id'),
    assertKeySegment(runId, 'run id'),
    `${assertKeySegment(objectId, 'object id')}.csv`,
  ].join('/')
}

export interface BoundedBody {
  bytes: Uint8Array
  sha256: string
}

/**
 * Read a request body, refusing to exceed `maxBytes`, and hash it.
 *
 * `Content-Length` is not consulted for anything but a courtesy early rejection: it is a
 * client-supplied header and a client that wants to overrun a quota will simply lie. The limit is
 * enforced against bytes actually read, and the stream is cancelled the moment it is crossed, so
 * an oversized upload costs the transfer up to the limit and no more.
 *
 * The body is accumulated rather than streamed straight to R2 because both the exact byte count
 * and the SHA-256 must be known *before* the object is committed to a user's quota, and WebCrypto
 * offers no incremental digest. `maxBytes` is what bounds the isolate's memory; it is configured
 * per object kind (16 MiB for a snapshot, 32 MiB for a source CSV) and is what makes this bounded
 * rather than unbounded buffering.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLargeCode: 'SOURCE_TOO_LARGE' | 'EXPORT_TOO_LARGE' | 'QUOTA_EXCEEDED',
): Promise<BoundedBody> {
  if (!body) {
    throw new ApiError('SNAPSHOT_INVALID', { details: { reason: 'empty_body' } })
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw new ApiError(tooLargeCode, { details: { maxBytes } })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return { bytes, sha256: await sha256Hex(bytes) }
}

/**
 * Stream a stored object to the client.
 *
 * `object.body` is handed to the `Response` untouched: a 12 MB snapshot never materialises in the
 * isolate. The caller has already proven ownership; this function only moves bytes.
 */
export function streamObject(object: R2ObjectBody, contentType: string, downloadName?: string): Response {
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(object.size),
    // Private data behind an authorization check must not be cached by anything in between.
    'cache-control': 'private, no-store',
    // Belt and braces against a browser deciding a stored blob is HTML and running it.
    'x-content-type-options': 'nosniff',
  })
  if (object.httpEtag) headers.set('etag', object.httpEtag)
  if (downloadName) {
    // The filename is echoed from stored metadata, RFC 5987 encoded so a Japanese filename
    // survives and so no quote or newline can break out of the header.
    headers.set(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(downloadName).replace(
        /['()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      )}`,
    )
  }
  return new Response(object.body, { headers })
}
