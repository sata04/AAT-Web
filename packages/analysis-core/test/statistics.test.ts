/** Boundary cases for the exact statistics path, outside the frozen fixtures. */

import { describe, expect, it } from 'vitest'
import { AnalysisParameterError, DataProcessingError } from '../src/errors.ts'
import { calculateStatistics, windowSampleCount } from '../src/statistics.ts'

describe('windowSampleCount', () => {
  it('rejects overflow from finite operands as an analysis parameter error', () => {
    // core/statistics.py raises OverflowError when round receives infinity.
    expect(() => windowSampleCount(1e308, 10)).toThrow(AnalysisParameterError)
    expect(() =>
      calculateStatistics(Float64Array.of(1, 2), Float64Array.of(0, 1), {
        windowSize: 1e308,
        samplingRate: 10,
      }),
    ).toThrow(expect.objectContaining({ code: 'ANALYSIS_PARAMETER_INVALID' }))
  })
})

describe('calculateStatistics', () => {
  it('returns the first complete window when every standard deviation overflows', () => {
    // Finite samples are complete; the reference returns a mean of |gravity|
    // and +Infinity for the squared-deviation overflow, not three nulls.
    expect(
      calculateStatistics(Float64Array.of(1e200, -1e200), Float64Array.of(0, 1), {
        windowSize: 2,
        samplingRate: 1,
      }),
    ).toEqual({ mean: 1e200, startTime: 0, std: Number.POSITIVE_INFINITY })
  })

  it('matches nanargmin selecting an incomplete prefix tied with infinite deviations', () => {
    // The oracle uses ndarray.std (not masked-array std), then writes NaN to
    // incomplete windows. nanargmin replaces NaNs with +Inf before argmin.
    expect(
      calculateStatistics(Float64Array.of(Number.NaN, 1e200, -1e200), Float64Array.of(0, 1, 2), {
        windowSize: 2,
        samplingRate: 1,
      }),
    ).toEqual({ mean: Number.NaN, startTime: 0, std: Number.NaN })
  })

  it('rejects complete windows whose computed deviations are all NaN', () => {
    const values = Float64Array.of(1e308, 1e308, -1e308, -1e308, 1e308, 1e308, -1e308, -1e308)
    const calculate = () =>
      calculateStatistics(
        values,
        Float64Array.from(values, (_, index) => index),
        {
          windowSize: 8,
          samplingRate: 1,
        },
      )
    expect(calculate).toThrow(DataProcessingError)
    expect(calculate).toThrow(
      expect.objectContaining({
        code: 'STATISTICS_ALL_NAN',
        message: 'All-NaN slice encountered',
      }),
    )
  })

  it('preserves a computed NaN tied with later infinite deviations, as the oracle does', () => {
    const values = Float64Array.of(1e308, 1e308, -1e308, -1e308, 1e308, 1e308, -1e308, -1e308, 1e200)
    expect(
      calculateStatistics(
        values,
        Float64Array.from(values, (_, index) => index),
        {
          windowSize: 8,
          samplingRate: 1,
        },
      ),
    ).toEqual({ mean: Number.POSITIVE_INFINITY, startTime: 0, std: Number.NaN })
  })

  it('selects a finite minimum after computed NaN and infinite deviations', () => {
    const values = Float64Array.of(
      1e308,
      1e308,
      -1e308,
      -1e308,
      1e308,
      1e308,
      -1e308,
      -1e308,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    )
    expect(
      calculateStatistics(
        values,
        Float64Array.from(values, (_, index) => index),
        {
          windowSize: 8,
          samplingRate: 1,
        },
      ),
    ).toEqual({ mean: 0, startTime: 8, std: 0 })
  })

  it('retains an infinite deviation before an incomplete suffix', () => {
    expect(
      calculateStatistics(Float64Array.of(1e200, -1e200, Number.NaN), Float64Array.of(0, 1, 2), {
        windowSize: 2,
        samplingRate: 1,
      }),
    ).toEqual({ mean: 1e200, startTime: 0, std: Number.POSITIVE_INFINITY })
  })

  it('still reports no statistics when no complete window exists', () => {
    expect(
      calculateStatistics(Float64Array.of(1e200, Number.NaN, -1e200), Float64Array.of(0, 1, 2), {
        windowSize: 2,
        samplingRate: 1,
      }),
    ).toEqual({ mean: null, startTime: null, std: null })
  })
})
