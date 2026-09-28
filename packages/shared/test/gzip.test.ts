import { afterEach, describe, expect, it, vi } from 'vitest'
import { gzipCompress, gzipDecompress } from '../src/gzip.ts'

afterEach(() => vi.unstubAllGlobals())

describe('gzip output admission independent of native backpressure', () => {
  it('rejects a high-expansion stream without using DecompressionStream or trusting ISIZE', async () => {
    const bomb = await gzipCompress(new Uint8Array(32 * 1024 * 1024))
    // Attacker-controlled gzip trailer must not determine the allocation or bypass the cap.
    bomb.fill(0, bomb.length - 4)
    vi.stubGlobal(
      'DecompressionStream',
      class {
        constructor() {
          throw new Error('native decoder used')
        }
      },
    )
    await expect(gzipDecompress(bomb, 4096)).rejects.toThrow(RangeError)
    const small = new Uint8Array([1, 2, 3])
    expect(await gzipDecompress(await gzipCompress(small), small.length)).toEqual(small)
  })

  it('accepts the exact cap and empty output, rejecting one byte over', async () => {
    const input = new Uint8Array(1024 * 1024).fill(42)
    const gzip = await gzipCompress(input)
    expect(await gzipDecompress(gzip, input.length)).toEqual(input)
    await expect(gzipDecompress(gzip, input.length - 1)).rejects.toThrow(RangeError)
    expect(await gzipDecompress(await gzipCompress(new Uint8Array()), 0)).toEqual(new Uint8Array())
  })

  it.each(['crc', 'size', 'truncated', 'concatenated'] as const)('rejects %s corruption', async (kind) => {
    let gzip = await gzipCompress(new Uint8Array([1, 2, 3]))
    if (kind === 'crc') gzip[gzip.length - 8] = (gzip[gzip.length - 8] ?? 0) ^ 1
    if (kind === 'size') gzip[gzip.length - 4] = 99
    if (kind === 'truncated') gzip = gzip.subarray(0, gzip.length - 5)
    if (kind === 'concatenated') gzip = new Uint8Array([...gzip, ...gzip])
    await expect(gzipDecompress(gzip, 100)).rejects.toThrow()
  })
})
