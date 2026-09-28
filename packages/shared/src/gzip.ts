/** Native gzip compression; synchronous JS inflation makes the decoded cap runtime-independent. */
import { Gunzip } from 'fflate/browser'

async function readAllChunks(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
  }
  return joinChunks(chunks, size)
}

function joinChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

/** Compress raw bytes with gzip. */
export async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  const writing = (async () => {
    await writer.write(bytes as BufferSource)
    await writer.close()
  })()
  const [output] = await Promise.all([readAllChunks(stream.readable), writing])
  return output
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  return crc >>> 0
})
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 255] ?? 0)
  return crc
}

/**
 * Decompress one gzip member, rejecting bytes past the optional decoded ceiling.
 *
 * workerd's native DecompressionStream can buffer the whole expansion before reads/cancellation.
 * fflate emits synchronously on each push; throwing here prevents the next push. Limit compressed
 * pushes too: a callback alone would still let the inflater allocate a bomb-sized first chunk.
 * DEFLATE's maximum expansion is ~1032:1, so 256 input bytes expand to at most ~258 KiB per push
 * (plus a carried stored block <=64 KiB and the 32 KiB history). fflate's doubling/copying adds
 * constant workspace; retained output is <=maxDecodedBytes, plus its final joined copy. This is
 * O(cap + fixed inflater workspace), not a claim that total heap use equals the cap.
 *
 * fflate does not check gzip CRC/ISIZE. Check both, and FHCRC when present, to retain the native
 * decoder's corruption detection. Like Compression Streams, accept only one gzip member.
 */
export async function gzipDecompress(bytes: Uint8Array, maxDecodedBytes?: number): Promise<Uint8Array> {
  if (maxDecodedBytes !== undefined && (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0)) {
    throw new RangeError('maxDecodedBytes must be a nonnegative safe integer')
  }
  const cap = maxDecodedBytes ?? Number.POSITIVE_INFINITY
  const invalid = () => new Error('Invalid gzip data')
  if (bytes.length < 18 || bytes[0] !== 31 || bytes[1] !== 139 || bytes[2] !== 8) throw invalid()
  const flags = bytes[3] ?? 0
  if (flags & 0xe0) throw invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let headerEnd = 10
  if (flags & 4) headerEnd += 2 + view.getUint16(headerEnd, true)
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (headerEnd < bytes.length - 8 && bytes[headerEnd] !== 0) headerEnd++
      headerEnd++
    }
  }
  // Bound optional metadata buffering in the streaming decoder as well as decoded output.
  if (headerEnd > bytes.length - 8 || headerEnd > 65536) throw invalid()
  if (flags & 2) {
    if (headerEnd + 2 > bytes.length - 8) throw invalid()
    const headerCrc = (updateCrc(-1, bytes.subarray(0, headerEnd)) ^ -1) & 0xffff
    if (view.getUint16(headerEnd, true) !== headerCrc) throw invalid()
  }

  const chunks: Uint8Array[] = []
  let size = 0
  let crc = -1
  const decoder = new Gunzip((chunk) => {
    if (chunk.length > cap - size) throw new RangeError('Decoded gzip exceeds maxDecodedBytes')
    if (chunk.length) chunks.push(chunk)
    size += chunk.length
    crc = updateCrc(crc, chunk)
  })
  decoder.onmember = () => {
    throw invalid()
  }
  for (let offset = 0; offset < bytes.length; offset += 256) {
    decoder.push(bytes.subarray(offset, offset + 256), offset + 256 >= bytes.length)
  }
  if (
    view.getUint32(bytes.length - 8, true) !== (crc ^ -1) >>> 0 ||
    view.getUint32(bytes.length - 4, true) !== size >>> 0
  )
    throw invalid()
  return joinChunks(chunks, size)
}
