/**
 * Gzip compression built on the browser/Worker-native `CompressionStream` / `DecompressionStream`
 * ('gzip' format) — no compression library dependency, per project policy. Both the browser app
 * and the Cloudflare Worker runtime implement these constructors natively.
 *
 * Used to shrink an encoded snapshot (`snapshot.ts`) before it is stored or transferred; the
 * snapshot's own JSON/base64 encoding is intentionally uncompressed and exact; this is purely a
 * transport/storage optimisation layered on top.
 */

async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let totalLength = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined) {
      chunks.push(value)
      totalLength += value.length
    }
  }

  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

async function pipeThroughStream(
  bytes: Uint8Array,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter()
  // Same ArrayBuffer-vs-ArrayBufferLike lib.dom.d.ts nuance as in hash.ts: a plain Uint8Array is
  // never actually SharedArrayBuffer-backed here, so this satisfies BufferSource in practice.
  const writePromise = writer.write(bytes as BufferSource).then(() => writer.close())
  const [output] = await Promise.all([readAllChunks(stream.readable), writePromise])
  return output
}

/** Compress raw bytes with gzip. */
export function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThroughStream(bytes, new CompressionStream('gzip'))
}

/** Decompress gzip-compressed bytes produced by {@link gzipCompress}. */
export function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeThroughStream(bytes, new DecompressionStream('gzip'))
}
