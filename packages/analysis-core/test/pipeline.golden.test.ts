/**
 * Holds the whole TypeScript pipeline to the Python oracle, bit-for-bit.
 *
 * For every fixture the suite reads the *raw CSV bytes* the reference read and
 * runs decode -> parse -> detectColumns -> loadAndProcessData -> filterData ->
 * calculateGQuality, comparing every array element and every scalar by IEEE-754
 * bit pattern. Nothing here is compared with a tolerance: see
 * docs/numerical-compatibility.md for why a "close enough" port is not enough
 * when the result is which window wins a minimum-standard-deviation search.
 */

import { describe, expect, it } from 'vitest'
import { detectColumns } from '../src/columns.ts'
import { analysisConfigFromRecord } from '../src/config.ts'
import { parseCsvText } from '../src/csv.ts'
import { decodeCsv } from '../src/decode.ts'
import { calculateGQuality } from '../src/gquality.ts'
import { filterData, loadAndProcessData } from '../src/pipeline.ts'
import {
  type ArrayRef,
  firstBitDifference,
  type GoldenRecord,
  type GoldenScalar,
  loadArray,
  loadFixtureBytes,
  loadGolden,
  loadIndex,
  sameBits,
  toNumber,
} from './golden.ts'

const index = loadIndex()

/** Full-precision rendering, so a failure names the bits rather than "0.98". */
function show(value: number): string {
  return `${value} (${value.toExponential(17)})`
}

function expectArray(actual: Float64Array, ref: ArrayRef | null | undefined, label: string) {
  const expected = loadArray(ref ?? null)
  if (expected === null) {
    expect(actual.length, `${label}: the reference produced no series`).toBe(0)
    return
  }
  expect(actual.length, `${label}: length`).toBe(expected.length)
  const difference = firstBitDifference(actual, expected)
  expect(
    difference,
    difference < 0
      ? ''
      : `${label}: first bit difference at index ${difference}: ` +
        `expected ${show(expected[difference] as number)}, received ${show(actual[difference] as number)}`,
  ).toBe(-1)
}

function expectScalar(actual: number | null, expected: GoldenScalar, label: string) {
  const target = toNumber(expected)
  if (target === null) {
    expect(actual, `${label}: expected null`).toBeNull()
    return
  }
  expect(actual, `${label}: expected ${show(target)}, received null`).not.toBeNull()
  expect(
    sameBits(actual as number, target),
    `${label}: expected ${show(target)}, received ${show(actual as number)}`,
  ).toBe(true)
}

/** Run every stage once per fixture; each `it` then asserts one aspect of it. */
function runFixture(golden: GoldenRecord) {
  const bytes = loadFixtureBytes(golden.csv)
  const decoded = decodeCsv(bytes)
  const table = parseCsvText(decoded.text)
  const config = analysisConfigFromRecord(golden.config)
  const loaded = loadAndProcessData(table, config)
  const filtered = filterData(loaded, config)
  const gQuality = calculateGQuality(filtered, config)
  return { decoded, table, config, detected: detectColumns(table), loaded, filtered, gQuality }
}

describe.each(index.fixtures.map((fixture) => fixture.name))('%s', (name) => {
  const golden = loadGolden(name)
  const actual = runFixture(golden)

  it('decodes with the encoding the reference used', () => {
    // The oracle records pandas' codec name; cp932 is read by the WHATWG
    // Shift_JIS decoder here (docs/numerical-compatibility.md, divergence 3).
    const expected = golden.csvEncoding === 'cp932' ? 'shift_jis' : 'utf-8'
    expect(actual.decoded.encoding).toBe(expected)
  })

  it('detects the same column candidates', () => {
    expect(actual.detected.time).toEqual(golden.detectedColumns.time)
    expect(actual.detected.acceleration).toEqual(golden.detectedColumns.acceleration)
  })

  it('finds the same sync points and fallbacks', () => {
    expect(actual.loaded.sync.innerIndex).toBe(golden.sync.innerIndex)
    expect(actual.loaded.sync.dragIndex).toBe(golden.sync.dragIndex)
    expect(actual.loaded.sync.innerFallback).toBe(golden.sync.innerFallback)
    expect(actual.loaded.sync.dragFallback).toBe(golden.sync.dragFallback)
    expect(actual.loaded.sync.innerCandidateCount).toBe(golden.sync.innerCandidateCount)
    expect(actual.loaded.sync.dragCandidateCount).toBe(golden.sync.dragCandidateCount)
  })

  it('reproduces the adjusted time axes bit-for-bit', () => {
    expectArray(actual.loaded.inner.time, golden.arrays.innerAdjustedTime, 'innerAdjustedTime')
    expectArray(actual.loaded.drag.time, golden.arrays.dragAdjustedTime, 'dragAdjustedTime')
  })

  it('reproduces the gravity series bit-for-bit', () => {
    expectArray(actual.loaded.inner.gravity, golden.arrays.innerGravity, 'innerGravity')
    expectArray(actual.loaded.drag.gravity, golden.arrays.dragGravity, 'dragGravity')
  })

  it('trims each sensor to the same bounds', () => {
    expect(actual.filtered.endIndex, 'filter.endIndex').toBe(golden.filter.endIndex)
    expect(actual.filtered.inner.gravity.length, 'filter.innerLength').toBe(golden.filter.innerLength)
    expect(actual.filtered.drag.gravity.length, 'filter.dragLength').toBe(golden.filter.dragLength)
    expect(actual.filtered.inner.startIndex, 'filter.innerStartIndex').toBe(golden.filter.innerStartIndex)
    expect(actual.filtered.inner.endIndex, 'filter.innerEndIndex').toBe(golden.filter.innerEndIndex)
    expect(actual.filtered.drag.startIndex, 'filter.dragStartIndex').toBe(golden.filter.dragStartIndex)
    expect(actual.filtered.drag.endIndex, 'filter.dragEndIndex').toBe(golden.filter.dragEndIndex)
  })

  it('reproduces the filtered series bit-for-bit', () => {
    expectArray(actual.filtered.inner.time, golden.arrays.filteredTime, 'filteredTime')
    expectArray(actual.filtered.drag.time, golden.arrays.filteredAdjustedTime, 'filteredAdjustedTime')
    expectArray(actual.filtered.inner.gravity, golden.arrays.filteredInnerGravity, 'filteredInnerGravity')
    expectArray(actual.filtered.drag.gravity, golden.arrays.filteredDragGravity, 'filteredDragGravity')
  })

  it('reproduces the G-quality sweep', () => {
    const rows = actual.gQuality.rows
    expect(rows.length, 'gQuality row count').toBe(golden.gQuality.length)
    for (let index = 0; index < golden.gQuality.length; index++) {
      const expected = golden.gQuality[index] as GoldenRecord['gQuality'][number]
      const row = rows[index] as (typeof rows)[number]
      const at = `gQuality[${index}]`
      expectScalar(row.windowSize, expected.windowSize, `${at}.windowSize`)
      expectScalar(row.innerStartTime, expected.innerStartTime, `${at}.innerStartTime`)
      expectScalar(row.innerMean, expected.innerMean, `${at}.innerMean`)
      expectScalar(row.innerStd, expected.innerStd, `${at}.innerStd`)
      expectScalar(row.dragStartTime, expected.dragStartTime, `${at}.dragStartTime`)
      expectScalar(row.dragMean, expected.dragMean, `${at}.dragMean`)
      expectScalar(row.dragStd, expected.dragStd, `${at}.dragStd`)
    }
  })
})
