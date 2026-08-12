import { describe, expect, it } from 'vitest'
import { configHash, DEFAULT_ANALYSIS_CONFIG } from '../src/config.ts'
import { gzipCompress, gzipDecompress } from '../src/gzip.ts'
import { sha256Hex } from '../src/hash.ts'
import {
  type AnalysisSnapshot,
  decodeScalar,
  decodeSeries,
  decodeSnapshot,
  encodeScalar,
  encodeSeries,
  encodeSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  snapshotIntegritySha256,
} from '../src/snapshot.ts'

async function buildSnapshot(): Promise<AnalysisSnapshot> {
  const config = DEFAULT_ANALYSIS_CONFIG
  const innerGravity = new Float64Array([0, 0.001, Number.NaN, Number.POSITIVE_INFINITY, -0])
  const dragGravity = new Float64Array([0, -0.002, 0.5, Number.NEGATIVE_INFINITY, 8.09])

  return {
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    analysisEngineVersion: '1.0.0',
    appVersion: '1.0.0',
    sourceSha256: await sha256Hex('fake source csv bytes'),
    originalFilename: '260812_data.csv',
    config,
    configHash: await configHash(config),
    detectedColumns: { time: ['Time (s)'], acceleration: ['Z-axis acceleration 1(m/s2)'] },
    sync: {
      innerIndex: 304,
      dragIndex: 305,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1200,
      dragCandidateCount: 1199,
    },
    filter: {
      endIndex: 1567,
      innerLength: 1264,
      dragLength: 1261,
      innerStartIndex: 304,
      innerEndIndex: 1567,
      dragStartIndex: 305,
      dragEndIndex: 1565,
    },
    warnings: ['drag shield sync used a fallback index'],
    series: {
      innerAdjustedTime: encodeSeries(new Float64Array([0, 0.001, 0.002, 0.003, 0.004])),
      dragAdjustedTime: encodeSeries(new Float64Array([0, 0.001, 0.002, 0.003, 0.004])),
      innerGravity: encodeSeries(innerGravity),
      dragGravity: encodeSeries(dragGravity),
      innerAcceleration: encodeSeries(new Float64Array([9.8, 9.81, 9.79, 9.8, 9.8])),
      dragAcceleration: encodeSeries(new Float64Array([9.8, 9.81, 9.79, 9.8, 9.8])),
      filteredTime: encodeSeries(new Float64Array([0.001, 0.002])),
      filteredAdjustedTime: encodeSeries(new Float64Array([0.001, 0.002])),
      filteredInnerGravity: encodeSeries(new Float64Array([0.001, Number.NaN])),
      filteredDragGravity: encodeSeries(new Float64Array([-0.002, 0.5])),
    },
    statistics: {
      inner: {
        mean: encodeScalar(0.001076611864507575),
        startTime: encodeScalar(0.623),
        std: encodeScalar(-0),
      },
      drag: { mean: encodeScalar(null), startTime: encodeScalar(null), std: encodeScalar(null) },
    },
    gQuality: [
      {
        windowSize: 0.1,
        innerStartTime: encodeScalar(0.623),
        innerMean: encodeScalar(Number.NaN),
        innerStd: encodeScalar(0.001),
        dragStartTime: encodeScalar(Number.POSITIVE_INFINITY),
        dragMean: encodeScalar(Number.NEGATIVE_INFINITY),
        dragStd: encodeScalar(0.002),
      },
    ],
    provenance: { source: 'csv_upload', uploadedByUserId: 'user-1', uploadedAt: '2026-08-12T00:00:00.000Z' },
    analysisTimestamp: '2026-08-12T00:00:01.000Z',
  }
}

describe('scalar encoding', () => {
  it('round-trips finite numbers unchanged', () => {
    expect(decodeScalar(encodeScalar(0.001076611864507575))).toBe(0.001076611864507575)
    expect(decodeScalar(encodeScalar(0))).toBe(0)
  })

  it('round-trips NaN, +Infinity and -Infinity via tagged strings', () => {
    expect(encodeScalar(Number.NaN)).toBe('NaN')
    expect(encodeScalar(Number.POSITIVE_INFINITY)).toBe('Infinity')
    expect(encodeScalar(Number.NEGATIVE_INFINITY)).toBe('-Infinity')
    expect(Number.isNaN(decodeScalar('NaN'))).toBe(true)
    expect(decodeScalar('Infinity')).toBe(Number.POSITIVE_INFINITY)
    expect(decodeScalar('-Infinity')).toBe(Number.NEGATIVE_INFINITY)
  })

  it('distinguishes -0 from 0 through JSON, where a plain number encoding would collapse it', () => {
    expect(encodeScalar(-0)).toBe('-0')
    expect(JSON.stringify(-0)).toBe('0') // the exact failure mode this tag exists to avoid
    const decoded = decodeScalar('-0')
    expect(Object.is(decoded, -0)).toBe(true)
  })

  it('round-trips null as null', () => {
    expect(encodeScalar(null)).toBeNull()
    expect(decodeScalar(null)).toBeNull()
  })
})

describe('series encoding', () => {
  it('round-trips a Float64Array with NaN/Infinity/-0 through encodeSeries/decodeSeries', () => {
    const values = new Float64Array([
      0,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      8.09,
    ])
    const decoded = decodeSeries(encodeSeries(values))
    expect(new BigInt64Array(decoded.buffer)).toEqual(new BigInt64Array(values.buffer))
  })

  it('throws when the declared length disagrees with the decoded data', () => {
    const series = encodeSeries(new Float64Array([1, 2, 3]))
    expect(() => decodeSeries({ ...series, length: 99 })).toThrow()
  })
})

describe('encodeSnapshot / decodeSnapshot', () => {
  it('round-trips a full snapshot, preserving every series and scalar bit-exactly', async () => {
    const snapshot = await buildSnapshot()
    const encoded = encodeSnapshot(snapshot)
    expect(encoded).toBeInstanceOf(Uint8Array)

    const decoded = decodeSnapshot(encoded)
    expect(decoded).toEqual(snapshot)

    const originalInnerGravity = decodeSeries(snapshot.series.innerGravity)
    const roundTrippedInnerGravity = decodeSeries(decoded.series.innerGravity)
    expect(new BigInt64Array(roundTrippedInnerGravity.buffer)).toEqual(
      new BigInt64Array(originalInnerGravity.buffer),
    )
    expect(Number.isNaN(roundTrippedInnerGravity[2])).toBe(true)
    expect(Object.is(roundTrippedInnerGravity[4], -0)).toBe(true)

    expect(decoded.statistics.inner.std).toBe('-0')
    expect(decoded.gQuality[0]?.innerMean).toBe('NaN')
  })

  it('rejects a document with the wrong format version', async () => {
    const snapshot = await buildSnapshot()
    const encoded = encodeSnapshot(snapshot)
    const tampered = JSON.parse(new TextDecoder().decode(encoded)) as Record<string, unknown>
    tampered.snapshotFormatVersion = 999
    expect(() => decodeSnapshot(new TextEncoder().encode(JSON.stringify(tampered)))).toThrow()
  })

  it('rejects a document missing required fields', () => {
    expect(() =>
      decodeSnapshot(new TextEncoder().encode(JSON.stringify({ snapshotFormatVersion: 1 }))),
    ).toThrow()
  })

  it('rejects bytes that are not valid JSON', () => {
    expect(() => decodeSnapshot(new TextEncoder().encode('not json'))).toThrow()
  })

  it('computes a stable integrity hash over the encoded bytes', async () => {
    const snapshot = await buildSnapshot()
    const encoded = encodeSnapshot(snapshot)
    const hashA = await snapshotIntegritySha256(encoded)
    const hashB = await snapshotIntegritySha256(encodeSnapshot(await buildSnapshot()))
    expect(hashA).toBe(hashB)
    expect(hashA).toMatch(/^[0-9a-f]{64}$/)
  })

  it('survives a gzip round trip unchanged', async () => {
    const snapshot = await buildSnapshot()
    const encoded = encodeSnapshot(snapshot)
    const compressed = await gzipCompress(encoded)
    const decompressed = await gzipDecompress(compressed)
    expect(decompressed).toEqual(encoded)
    expect(decodeSnapshot(decompressed)).toEqual(snapshot)
  })
})
