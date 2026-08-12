/**
 * Holds the TypeScript statistics kernel to the Python oracle, bit-for-bit.
 *
 * These tests deliberately feed the *golden gravity arrays* rather than
 * re-deriving them from CSV, so a failure here is unambiguously a statistics
 * bug and not a parsing or filtering one. The end-to-end pipeline is covered
 * separately in `pipeline.golden.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { calculateRangeStatistics, calculateStatistics } from '../src/statistics.ts'
import { firstBitDifference, loadArray, loadGolden, loadIndex, sameBits, toNumber } from './golden.ts'

const index = loadIndex()

describe('golden index', () => {
  it('records which reference commit produced the fixtures', () => {
    expect(index.referenceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(index.fixtures.length).toBeGreaterThanOrEqual(20)
  })
})

/** Compare a nullable statistic against the golden, requiring bit equality. */
function expectScalar(actual: number | null, expected: ReturnType<typeof toNumber>, label: string) {
  if (expected === null) {
    expect(actual, `${label}: expected null`).toBeNull()
    return
  }
  expect(actual, `${label}: expected a value, got null`).not.toBeNull()
  const matched = sameBits(actual as number, expected)
  expect(
    matched,
    `${label}: expected ${expected.toExponential(17)} but received ${(actual as number).toExponential(17)}`,
  ).toBe(true)
}

describe.each(index.fixtures.map((fixture) => fixture.name))('%s', (name) => {
  const golden = loadGolden(name)
  const windowSize = toNumber(golden.config.window_size as never) as number
  const samplingRate = toNumber(golden.config.sampling_rate as never) as number

  const cases = [
    {
      sensor: 'inner' as const,
      values: loadArray(golden.arrays.filteredInnerGravity ?? null),
      time: loadArray(golden.arrays.filteredTime ?? null),
      expected: golden.statistics.inner,
    },
    {
      sensor: 'drag' as const,
      values: loadArray(golden.arrays.filteredDragGravity ?? null),
      time: loadArray(golden.arrays.filteredAdjustedTime ?? null),
      expected: golden.statistics.drag,
    },
  ]

  for (const testCase of cases) {
    it(`reproduces the ${testCase.sensor} minimum-standard-deviation window`, () => {
      if (testCase.values === null || testCase.time === null) {
        expect(toNumber(testCase.expected.std)).toBeNull()
        return
      }
      const result = calculateStatistics(testCase.values, testCase.time, { windowSize, samplingRate })
      expectScalar(result.std, toNumber(testCase.expected.std), `${name}/${testCase.sensor} std`)
      expectScalar(result.mean, toNumber(testCase.expected.mean), `${name}/${testCase.sensor} mean`)
      expectScalar(
        result.startTime,
        toNumber(testCase.expected.startTime),
        `${name}/${testCase.sensor} startTime`,
      )
    })
  }

  it('reproduces range statistics for every recorded selection', () => {
    const innerTime = loadArray(golden.arrays.filteredTime ?? null)
    const innerValues = loadArray(golden.arrays.filteredInnerGravity ?? null)
    const dragTime = loadArray(golden.arrays.filteredAdjustedTime ?? null)
    const dragValues = loadArray(golden.arrays.filteredDragGravity ?? null)

    for (const selection of golden.rangeStatistics) {
      const xMin = toNumber(selection.xMin) as number
      const xMax = toNumber(selection.xMax) as number

      for (const [label, time, values, expected] of [
        ['inner', innerTime, innerValues, selection.inner],
        ['drag', dragTime, dragValues, selection.drag],
      ] as const) {
        // The desktop selection mask is inclusive at both ends.
        const selected: number[] = []
        if (time !== null && values !== null) {
          for (let i = 0; i < time.length; i++) {
            const t = time[i] as number
            if (t >= xMin && t <= xMax) selected.push(values[i] as number)
          }
        }
        const actual = calculateRangeStatistics(Float64Array.from(selected))
        const where = `${name}/${label} [${xMin}, ${xMax}]`
        expect(actual.count, `${where} count`).toBe(expected.count)
        expect(actual.missing, `${where} missing`).toBe(expected.missing)
        expectScalar(actual.mean, toNumber(expected.mean), `${where} mean`)
        expectScalar(actual.absMean, toNumber(expected.abs_mean), `${where} abs_mean`)
        expectScalar(actual.std, toNumber(expected.std), `${where} std`)
        expectScalar(actual.min, toNumber(expected.min), `${where} min`)
        expectScalar(actual.max, toNumber(expected.max), `${where} max`)
        expectScalar(actual.range, toNumber(expected.range), `${where} range`)
      }
    }
  })

  it('reproduces the G-quality sweep', () => {
    const innerValues = loadArray(golden.arrays.filteredInnerGravity ?? null)
    const innerTime = loadArray(golden.arrays.filteredTime ?? null)
    const dragValues = loadArray(golden.arrays.filteredDragGravity ?? null)
    const dragTime = loadArray(golden.arrays.filteredAdjustedTime ?? null)

    for (const row of golden.gQuality) {
      const windowSizeSeconds = toNumber(row.windowSize) as number

      if (innerValues !== null && innerTime !== null) {
        const result = calculateStatistics(innerValues, innerTime, {
          windowSize: windowSizeSeconds,
          samplingRate,
        })
        const where = `${name}/inner w=${windowSizeSeconds}`
        expectScalar(result.std, toNumber(row.innerStd), `${where} std`)
        expectScalar(result.mean, toNumber(row.innerMean), `${where} mean`)
        expectScalar(result.startTime, toNumber(row.innerStartTime), `${where} startTime`)
      }
      if (dragValues !== null && dragTime !== null) {
        const result = calculateStatistics(dragValues, dragTime, {
          windowSize: windowSizeSeconds,
          samplingRate,
        })
        const where = `${name}/drag w=${windowSizeSeconds}`
        expectScalar(result.std, toNumber(row.dragStd), `${where} std`)
        expectScalar(result.mean, toNumber(row.dragMean), `${where} mean`)
        expectScalar(result.startTime, toNumber(row.dragStartTime), `${where} startTime`)
      }
    }
  })
})

describe('golden array integrity', () => {
  it('loads every referenced payload at the recorded length', () => {
    for (const fixture of index.fixtures) {
      const golden = loadGolden(fixture.name)
      for (const [key, ref] of Object.entries(golden.arrays)) {
        if (ref === null) continue
        const values = loadArray(ref)
        expect(values, `${fixture.name}.${key}`).not.toBeNull()
        expect((values as Float64Array).length).toBe(ref.length)
        // Self-check the loader's bit comparator against an identical copy.
        expect(firstBitDifference(values as Float64Array, values as Float64Array)).toBe(-1)
      }
    }
  })
})
