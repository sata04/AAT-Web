/**
 * Unit coverage for the G-quality sweep: the window ladder, the skip
 * conditions, progress reporting, and the rule that a row needs at least one
 * usable mean.
 */

import { describe, expect, it } from 'vitest'
import { type AnalysisConfig, DEFAULT_ANALYSIS_CONFIG } from '../src/config.ts'
import { calculateGQuality, type GQualityProgress, gQualityWindowSizes } from '../src/gquality.ts'
import type { FilterResult } from '../src/pipeline.ts'

function series(length: number, value: (index: number) => number): Float64Array {
  const values = new Float64Array(length)
  for (let index = 0; index < length; index++) values[index] = value(index)
  return values
}

function filterResult(inner: Float64Array, drag: Float64Array, samplingRate: number): FilterResult {
  const time = (length: number) => series(length, (index) => index / samplingRate)
  return {
    inner: {
      time: time(inner.length),
      gravity: inner,
      startIndex: inner.length > 0 ? 0 : null,
      endIndex: inner.length > 0 ? inner.length - 1 : null,
    },
    drag: {
      time: time(drag.length),
      gravity: drag,
      startIndex: drag.length > 0 ? 0 : null,
      endIndex: drag.length > 0 ? drag.length - 1 : null,
    },
    endIndex: Math.max(inner.length, drag.length) - 1,
    warnings: [],
  }
}

const CONFIG: AnalysisConfig = {
  ...DEFAULT_ANALYSIS_CONFIG,
  samplingRate: 100,
  gQualityStart: 0.1,
  gQualityEnd: 0.2,
  gQualityStep: 0.05,
}

describe('gQualityWindowSizes', () => {
  it('reproduces NumPy’s arange drift exactly', () => {
    const ladder = Array.from(gQualityWindowSizes(0.1, 1.0, 0.05))
    expect(ladder.length).toBe(19)
    expect(ladder[0]).toBe(0.1)
    // arange derives its step from the materialised first two elements, so the
    // ladder drifts; these are the values the reference reports to the user.
    expect(ladder[1]).toBe(0.15000000000000002)
    expect(ladder[2]).toBe(0.20000000000000004)
    expect(ladder[18]).toBe(1.0)
  })

  it('clamps the final window to the configured end', () => {
    const ladder = Array.from(gQualityWindowSizes(0.1, 0.2, 0.05))
    expect(ladder).toEqual([0.1, 0.15000000000000002, 0.2])
  })

  it('returns a single window when the range does not admit a step', () => {
    expect(Array.from(gQualityWindowSizes(0.5, 0.5, 0.1))).toEqual([0.5])
  })
})

describe('calculateGQuality', () => {
  it('sweeps every window and reports progress', () => {
    const inner = series(40, (index) => 0.001 * Math.sin(index))
    const drag = series(40, (index) => 0.002 * Math.cos(index))
    const progress: GQualityProgress[] = []

    const result = calculateGQuality(filterResult(inner, drag, 100), CONFIG, (update) =>
      progress.push(update),
    )

    expect(result.rows.length).toBe(3)
    expect(result.rows.map((row) => row.windowSize)).toEqual([0.1, 0.15000000000000002, 0.2])
    for (const row of result.rows) {
      expect(row.innerMean).not.toBeNull()
      expect(row.dragMean).not.toBeNull()
      expect(row.innerStd).toBeGreaterThanOrEqual(0)
    }
    expect(progress.length).toBe(3)
    expect(progress[2]?.percent).toBe(100)
    expect(progress[2]?.total).toBe(3)
  })

  it('skips a sensor whose series is shorter than the window', () => {
    // 12 samples at 100 Hz covers the 0.1 s window but not the 0.15 s one.
    const inner = series(12, (index) => 0.001 * index)
    const drag = series(40, (index) => 0.002 * index)
    const result = calculateGQuality(filterResult(inner, drag, 100), CONFIG)

    expect(result.rows[0]?.innerMean).not.toBeNull()
    expect(result.rows[1]?.innerMean).toBeNull()
    expect(result.rows[1]?.innerStd).toBeNull()
    expect(result.rows[1]?.dragMean).not.toBeNull()
  })

  it('emits no row when neither sensor produced a mean', () => {
    // Every window holds a missing sample, so no window is eligible.
    const inner = series(40, () => Number.NaN)
    const result = calculateGQuality(filterResult(inner, new Float64Array(0), 100), CONFIG)
    expect(result.rows).toEqual([])
  })

  it('skips the sweep when nothing is long enough for the smallest window', () => {
    const inner = series(4, (index) => 0.001 * index)
    const result = calculateGQuality(filterResult(inner, new Float64Array(0), 100), CONFIG)
    expect(result.rows).toEqual([])
    expect(result.warnings.map((entry) => entry.code)).toEqual(['GQUALITY_SKIPPED'])
    expect(result.warnings[0]?.details.reason).toBe('too-short')
  })

  it('skips the sweep when neither sensor has data at all', () => {
    const result = calculateGQuality(filterResult(new Float64Array(0), new Float64Array(0), 100), CONFIG)
    expect(result.rows).toEqual([])
    expect(result.warnings[0]?.details.reason).toBe('no-data')
  })
})
