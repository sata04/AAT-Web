import { describe, expect, it } from 'vitest'
import { isPosterSpecError, PosterSpecError } from '../src/errors.ts'
import { asFullResolutionSeries, isFullResolutionSeries } from '../src/source.ts'
import { fullResolutionSeries } from './helpers.ts'

describe('asFullResolutionSeries', () => {
  it('wraps a matched pair of Float64Arrays', () => {
    const series = asFullResolutionSeries(Float64Array.from([0, 1, 2]), Float64Array.from([9, 8, 7]))
    expect(series.length).toBe(3)
    expect([...series.time]).toEqual([0, 1, 2])
    expect([...series.values]).toEqual([9, 8, 7])
  })

  it('references the caller arrays rather than copying them', () => {
    const time = Float64Array.from([0, 1])
    const series = asFullResolutionSeries(time, Float64Array.from([1, 2]))
    expect(series.time).toBe(time)
  })

  it('rejects mismatched lengths', () => {
    try {
      asFullResolutionSeries(Float64Array.from([0, 1, 2]), Float64Array.from([1, 2]))
      expect.unreachable('expected a PosterSpecError')
    } catch (error) {
      expect(isPosterSpecError(error)).toBe(true)
      const posterError = error as PosterSpecError
      expect(posterError.code).toBe('POSTER_SOURCE_INVALID')
      expect(posterError.details).toMatchObject({ reason: 'length_mismatch', timeLength: 3, valuesLength: 2 })
    }
  })

  it('rejects arrays that are not Float64Array, including Float32Array', () => {
    // A Float32Array would silently round every published sample, so it is not "close enough".
    const rejected = () =>
      asFullResolutionSeries(Float32Array.from([0, 1]) as unknown as Float64Array, Float64Array.from([1, 2]))
    expect(rejected).toThrow(PosterSpecError)
    try {
      rejected()
    } catch (error) {
      expect((error as PosterSpecError).details).toMatchObject({
        reason: 'not_float64_array',
        timeType: 'Float32Array',
      })
    }
  })

  it('rejects a plain number array', () => {
    expect(() =>
      asFullResolutionSeries([0, 1] as unknown as Float64Array, [1, 2] as unknown as Float64Array),
    ).toThrow(PosterSpecError)
  })

  it('accepts empty arrays; emptiness is the builder’s decision, not the mint’s', () => {
    const series = asFullResolutionSeries(new Float64Array(0), new Float64Array(0))
    expect(series.length).toBe(0)
  })
})

describe('isFullResolutionSeries', () => {
  it('accepts a minted series', () => {
    expect(isFullResolutionSeries(fullResolutionSeries([0, 1], [1, 2]))).toBe(true)
  })

  it('rejects a structurally identical object literal', () => {
    // The brand is a module-private Symbol(), so it cannot be written from outside source.ts and
    // cannot be reached through the global symbol registry either.
    const forged = {
      time: Float64Array.from([0, 1]),
      values: Float64Array.from([1, 2]),
      length: 2,
      [Symbol.for('aat.plotSpec.fullResolutionSeries')]: true,
    }
    expect(isFullResolutionSeries(forged)).toBe(false)
  })

  it('rejects a bare Float64Array, null and undefined', () => {
    expect(isFullResolutionSeries(Float64Array.from([1, 2]))).toBe(false)
    expect(isFullResolutionSeries(null)).toBe(false)
    expect(isFullResolutionSeries(undefined)).toBe(false)
  })
})
