/**
 * Loader for the Python oracle's golden files.
 *
 * The goldens are produced by `reference/python/generate_golden.py` running the
 * vendored AAT desktop core. Float64 payloads live in content-addressed binary
 * files so they survive the round trip bit-for-bit; scalars come through JSON,
 * where Python's shortest-round-trip float repr and JavaScript's parser agree
 * on the same double.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const GOLDEN_DIR = join(HERE, '..', '..', '..', 'tests', 'golden')
export const FIXTURE_DIR = join(HERE, '..', '..', '..', 'tests', 'fixtures')

export interface ArrayRef {
  file: string
  sha256: string
  length: number
  finiteCount: number
  nanCount: number
  posInfCount: number
  negInfCount: number
}

/** Scalars are numbers, null, or the tagged non-finite strings. */
export type GoldenScalar = number | null | 'NaN' | 'Infinity' | '-Infinity'

export interface GoldenStatistics {
  mean: GoldenScalar
  startTime: GoldenScalar
  std: GoldenScalar
}

export interface GoldenRangeStatistics {
  mean: GoldenScalar
  abs_mean: GoldenScalar
  std: GoldenScalar
  min: GoldenScalar
  max: GoldenScalar
  range: GoldenScalar
  count: number
  missing: number
}

export interface GoldenRecord {
  goldenFormatVersion: number
  analysisEngineVersion: string
  name: string
  description: string
  csv: string
  csvEncoding: string
  csvSha256: string
  config: Record<string, GoldenScalar | string | boolean>
  detectedColumns: { time: string[]; acceleration: string[] }
  sync: {
    innerIndex: number | null
    dragIndex: number | null
    innerFallback: string | null
    dragFallback: string | null
    innerCandidateCount: number
    dragCandidateCount: number
  }
  arrays: Record<string, ArrayRef | null>
  filter: {
    endIndex: number
    innerLength: number
    dragLength: number
    innerStartIndex: number | null
    innerEndIndex: number | null
    dragStartIndex: number | null
    dragEndIndex: number | null
  }
  statistics: { inner: GoldenStatistics; drag: GoldenStatistics }
  gQuality: Array<{
    windowSize: GoldenScalar
    innerStartTime: GoldenScalar
    innerMean: GoldenScalar
    innerStd: GoldenScalar
    dragStartTime: GoldenScalar
    dragMean: GoldenScalar
    dragStd: GoldenScalar
  }>
  rangeStatistics: Array<{
    xMin: GoldenScalar
    xMax: GoldenScalar
    inner: GoldenRangeStatistics
    drag: GoldenRangeStatistics
  }>
}

export interface GoldenIndex {
  goldenFormatVersion: number
  analysisEngineVersion: string
  referenceCommit: string
  fixtures: Array<{
    name: string
    description: string
    golden: string
    csv: string
    csvSha256: string
    encoding: string
  }>
}

export function loadIndex(): GoldenIndex {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, 'index.json'), 'utf8')) as GoldenIndex
}

export function loadGolden(name: string): GoldenRecord {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf8')) as GoldenRecord
}

/** Raw CSV bytes exactly as the Python oracle read them. */
export function loadFixtureBytes(relativePath: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURE_DIR, relativePath)))
}

/** Materialise a referenced float64 payload. */
export function loadArray(ref: ArrayRef | null): Float64Array | null {
  if (ref === null) return null
  const buffer = readFileSync(join(GOLDEN_DIR, ref.file))
  // The file is little-endian float64; slice() gives an aligned copy.
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const values = new Float64Array(copy)
  if (values.length !== ref.length) {
    throw new Error(`Golden array ${ref.file} has ${values.length} values, expected ${ref.length}`)
  }
  return values
}

/** Convert a tagged golden scalar into a JavaScript number (or null). */
export function toNumber(value: GoldenScalar): number | null {
  if (value === null) return null
  if (value === 'NaN') return Number.NaN
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY
  return value
}

/**
 * Bit-level comparison.
 *
 * `===` treats NaN as unequal and +0/-0 as equal, neither of which is what a
 * numerical contract wants, so compare the IEEE-754 bit patterns instead.
 */
export function sameBits(a: number, b: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true
  const view = new DataView(new ArrayBuffer(16))
  view.setFloat64(0, a)
  view.setFloat64(8, b)
  return view.getBigUint64(0) === view.getBigUint64(8)
}

/** First index where two arrays differ bitwise, or -1 when identical. */
export function firstBitDifference(actual: Float64Array, expected: Float64Array): number {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length)
  for (let index = 0; index < actual.length; index++) {
    if (!sameBits(actual[index] as number, expected[index] as number)) return index
  }
  return -1
}
