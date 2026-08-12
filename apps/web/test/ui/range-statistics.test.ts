/**
 * Range statistics come from full-resolution data.
 *
 * This is the test that guards the rule `docs/web-architecture.md` states:
 * decimated samples are for drawing pixels and nothing else. The type system
 * already refuses to compile a decimated array into a statistics call, so what
 * is checked here is the *numerical* consequence — that the reported statistics
 * match every original sample, not a min/max envelope of them.
 */

import { calculateRangeStatistics } from '@aat/analysis-core'
import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import { rangeStatisticsFor } from '../../src/app/range-statistics.ts'
import { buildDisplayGrid, decimateToGrid } from '../../src/graph/decimate.ts'
import { valuesInRange } from '../../src/graph/selection.ts'

const SAMPLES = 4000

function series(): {
  time: ReturnType<typeof asFullResolution>
  gravity: ReturnType<typeof asFullResolution>
} {
  const time = new Float64Array(SAMPLES)
  const gravity = new Float64Array(SAMPLES)
  for (let index = 0; index < SAMPLES; index++) {
    time[index] = index / 1000
    // Deterministic, zero-mean-ish noise with a couple of outliers.
    gravity[index] = Math.sin(index / 7) * 0.001 + Math.cos(index / 31) * 0.0004
  }
  gravity[1500] = 0.02
  gravity[1501] = -0.02
  return { time: asFullResolution(time), gravity: asFullResolution(gravity) }
}

function sensor(
  time: ReturnType<typeof asFullResolution>,
  gravity: ReturnType<typeof asFullResolution>,
): SensorDataset {
  const empty = asFullResolution(new Float64Array(0))
  return {
    present: true,
    time,
    gravity,
    filteredTime: time,
    filteredGravity: gravity,
    acceleration: empty,
    startIndex: 0,
    endIndex: gravity.length - 1,
  }
}

function dataset(): Dataset {
  const { time, gravity } = series()
  const empty = asFullResolution(new Float64Array(0))
  const emptySensor: SensorDataset = {
    present: false,
    time: empty,
    gravity: empty,
    filteredTime: empty,
    filteredGravity: empty,
    acceleration: empty,
    startIndex: null,
    endIndex: null,
  }
  return {
    name: 'run',
    filename: 'run.csv',
    sourceSha256: 'a'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'a1', 'a2'],
    mapping: { timeColumn: 't', innerColumn: 'a1', dragColumn: 'a2', useInner: true, useDrag: false },
    inner: sensor(time, gravity),
    drag: emptySensor,
    sync: {
      innerIndex: 0,
      dragIndex: null,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 0,
    },
    filterEndIndex: SAMPLES - 1,
    statistics: {
      inner: { mean: null, startTime: null, std: null },
      drag: { mean: null, startTime: null, std: null },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: SAMPLES,
    analysisTimestamp: '2026-01-01T00:00:00.000Z',
    fromCache: false,
  }
}

describe('range statistics use full resolution', () => {
  const range = { xMin: 1.0, xMax: 2.0 }

  it('counts every original sample in the range, not the drawn points', () => {
    const result = rangeStatisticsFor(dataset(), range)
    expect(result).not.toBeNull()
    // 1.000 to 2.000 inclusive at 1 kHz.
    expect(result?.inner.count).toBe(1001)
  })

  it('differs measurably from the same statistics over decimated data', () => {
    const { time, gravity } = series()
    const full = calculateRangeStatistics(valuesInRange(time, gravity, range))

    // What a naive implementation would do: decimate for the screen, then
    // measure the picture.
    const grid = buildDisplayGrid(range.xMin, range.xMax, 300)
    const drawn = decimateToGrid(grid, time, gravity).y
    const decimated = calculateRangeStatistics(Float64Array.from(drawn))

    expect(full.count).toBe(1001)
    expect(decimated.count).toBe(600)
    // A min/max envelope is systematically wider than the samples it summarises,
    // so its standard deviation is inflated. That is the error this rule avoids.
    expect(decimated.std as number).toBeGreaterThan((full.std as number) * 1.05)
  })

  it('captures outliers that fall between drawn columns', () => {
    const result = rangeStatisticsFor(dataset(), { xMin: 1.4, xMax: 1.6 })
    expect(result?.inner.max).toBeCloseTo(0.02, 12)
    expect(result?.inner.min).toBeCloseTo(-0.02, 12)
  })

  it('refuses a selection below the 0.001 s floor', () => {
    expect(rangeStatisticsFor(dataset(), { xMin: 1.0, xMax: 1.0005 })).toBeNull()
  })

  it('reports an empty selection rather than fabricating numbers', () => {
    const result = rangeStatisticsFor(dataset(), { xMin: 90, xMax: 95 })
    expect(result?.empty).toBe(true)
    expect(result?.inner.count).toBe(0)
    expect(result?.inner.mean).toBeNull()
  })

  it('leaves a disabled sensor at zero rather than borrowing the other one', () => {
    const result = rangeStatisticsFor(dataset(), range)
    expect(result?.drag.count).toBe(0)
    expect(result?.drag.std).toBeNull()
  })
})
