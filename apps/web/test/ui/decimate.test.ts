/**
 * Display decimation.
 *
 * The property that matters is the one stride sampling breaks: a single-sample
 * spike must survive. In a drop-tower recording that spike is the release shock,
 * which is what an operator is looking at the graph to find.
 */

import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import { buildDisplayGrid, columnsForWidth, decimateToGrid, displayValues } from '../../src/graph/decimate.ts'

function ramp(
  length: number,
  rate = 1000,
): { time: ReturnType<typeof asFullResolution>; values: ReturnType<typeof asFullResolution> } {
  const time = new Float64Array(length)
  const values = new Float64Array(length)
  for (let index = 0; index < length; index++) {
    time[index] = index / rate
    values[index] = Math.sin(index / 50) * 0.01
  }
  return { time: asFullResolution(time), values: asFullResolution(values) }
}

describe('grid construction', () => {
  it('emits two positions per column, strictly ascending', () => {
    const grid = buildDisplayGrid(0, 1, 4)
    expect(grid.x.length).toBe(8)
    for (let index = 1; index < grid.x.length; index++) {
      expect(grid.x[index] as number).toBeGreaterThan(grid.x[index - 1] as number)
    }
  })

  it('keeps every position inside the requested range', () => {
    const grid = buildDisplayGrid(0.5, 2.5, 16)
    for (const value of grid.x) {
      expect(value).toBeGreaterThanOrEqual(0.5)
      expect(value).toBeLessThanOrEqual(2.5)
    }
  })

  it('survives a degenerate range instead of dividing by zero', () => {
    const grid = buildDisplayGrid(1, 1, 8)
    expect(grid.x.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('caps columns at one per pixel', () => {
    expect(columnsForWidth(1200)).toBe(1200)
    expect(columnsForWidth(0)).toBe(2)
  })
})

describe('extreme preservation', () => {
  it('keeps a one-sample spike that stride sampling would delete', () => {
    const { time, values } = ramp(20_000)
    // A spike at an index that no every-nth stride would land on.
    const spikeIndex = 7331
    const mutable = Float64Array.from(values)
    mutable[spikeIndex] = 5
    const spiked = asFullResolution(mutable)

    const grid = buildDisplayGrid(0, 20, 600)
    const drawn = displayValues(decimateToGrid(grid, time, spiked))

    expect(Math.max(...drawn)).toBeCloseTo(5, 12)

    // The comparison this test exists for: 600 columns over 20,000 samples is a
    // stride of 33, and 7331 is not a multiple of it.
    const strided: number[] = []
    for (let index = 0; index < spiked.length; index += 33) strided.push(spiked[index] as number)
    expect(Math.max(...strided)).toBeLessThan(1)
  })

  it('keeps the global minimum and maximum of the source', () => {
    const { time, values } = ramp(50_000)
    const mutable = Float64Array.from(values)
    mutable[123] = -3.5
    mutable[48_222] = 2.25
    const marked = asFullResolution(mutable)

    const grid = buildDisplayGrid(0, 50, 800)
    const drawn = [...displayValues(decimateToGrid(grid, time, marked))].filter(Number.isFinite)

    expect(Math.min(...drawn)).toBeCloseTo(-3.5, 12)
    expect(Math.max(...drawn)).toBeCloseTo(2.25, 12)
  })

  it('emits at most two points per column', () => {
    const { time, values } = ramp(100_000)
    const grid = buildDisplayGrid(0, 100, 500)
    expect(decimateToGrid(grid, time, values).y.length).toBe(1000)
  })
})

describe('gaps and coverage', () => {
  it('leaves NaN where the sensor measured nothing', () => {
    const time = asFullResolution(Float64Array.from([0, 0.1, 0.2]))
    const values = asFullResolution(Float64Array.from([1, 1, 1]))
    // The grid extends well past the data; the tail must stay empty rather than
    // extrapolating a flat line that was never measured.
    const grid = buildDisplayGrid(0, 1, 10)
    const drawn = displayValues(decimateToGrid(grid, time, values))
    expect(Number.isNaN(drawn[drawn.length - 1] as number)).toBe(true)
  })

  it('interpolates between real samples when zoomed past the sampling interval', () => {
    // Two samples 0.1 s apart, a grid 100x finer: without interpolation the line
    // would be a row of isolated dots.
    const time = asFullResolution(Float64Array.from([0, 0.1]))
    const values = asFullResolution(Float64Array.from([0, 1]))
    const grid = buildDisplayGrid(0, 0.1, 20)
    const drawn = displayValues(decimateToGrid(grid, time, values))
    expect(drawn.every((value) => Number.isFinite(value))).toBe(true)
    // Halfway along, halfway up.
    const middle = drawn[Math.floor(drawn.length / 2)] as number
    expect(middle).toBeGreaterThan(0.4)
    expect(middle).toBeLessThan(0.6)
  })

  it('reports how many source samples were actually inside the viewport', () => {
    const { time, values } = ramp(1000)
    const grid = buildDisplayGrid(0, 0.5, 100)
    // 0.000 to 0.499 inclusive: half the run.
    expect(decimateToGrid(grid, time, values).sourceLength).toBe(500)
  })

  it('handles an empty series without throwing', () => {
    const empty = asFullResolution(new Float64Array(0))
    const grid = buildDisplayGrid(0, 1, 10)
    const series = decimateToGrid(grid, empty, empty)
    expect(series.sourceLength).toBe(0)
    expect(series.y.every((value) => Number.isNaN(value))).toBe(true)
  })
})
