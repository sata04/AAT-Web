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
  it.each([false, true])('owns every rounded boundary exactly once (unordered: %s)', (unordered) => {
    const boundaries = Array.from({ length: 9 }, (_, index) => (index === 8 ? 0.2 : -1 + index * (1.2 / 8)))
    for (let spike = 0; spike < boundaries.length; spike++) {
      const times = unordered ? [...boundaries].reverse() : boundaries
      const time = asFullResolution(Float64Array.from(times))
      const values = asFullResolution(Float64Array.from(times, (at) => (at === boundaries[spike] ? 999 : 0)))
      const grid = buildDisplayGrid(-1, 0.2, 8)
      const series = decimateToGrid(grid, time, values)
      expect(grid.xMax).toBe(0.2)
      expect(series.sourceLength).toBe(9)
      expect(series.y[Math.min(spike, 7) * 2 + 1]).toBe(999)
      expect([...series.y].filter((value) => value === 999)).toHaveLength(spike < 7 ? 2 : 1)
    }
  })

  it('includes a spike exactly at xMax without double-counting interior boundaries', () => {
    const time = asFullResolution(Float64Array.from([0, 0.25, 0.5, 0.75, 1]))
    const values = asFullResolution(Float64Array.from([0, 0, 0, 0, 10]))
    const series = decimateToGrid(buildDisplayGrid(0, 1, 2), time, values)
    expect([...series.y]).toEqual([0, 0, 0, 10])
    expect(series.sourceLength).toBe(5)
  })

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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'skips an invalid timestamp (%s) without stalling or interpolating across it',
    (missingTime) => {
      const time = asFullResolution(Float64Array.from([0, 1, missingTime, 2, 3, 4]))
      const values = asFullResolution(Float64Array.from([0, 0, 999, 10, -10, 0]))
      const series = decimateToGrid(buildDisplayGrid(0, 4, 8), time, values)
      expect(series.sourceLength).toBe(5)
      expect([...series.y.slice(6, 8)]).toEqual([Number.NaN, Number.NaN])
      const finite = [...series.y].filter(Number.isFinite)
      expect(Math.min(...finite)).toBe(-10)
      expect(Math.max(...finite)).toBe(10)
      expect([...series.y.slice(-2)]).toEqual([0, 0])
    },
  )

  it('leaves a run of NaN values visibly missing between measured samples', () => {
    const time = asFullResolution(Float64Array.from([0, 1, 2, 3, 4]))
    const values = asFullResolution(Float64Array.from([0, Number.NaN, Number.NaN, Number.NaN, 0]))
    const series = decimateToGrid(buildDisplayGrid(0, 4, 8), time, values)
    expect(series.sourceLength).toBe(2)
    expect(series.y.slice(2, -2).every(Number.isNaN)).toBe(true)
    expect([...series.y.slice(0, 2)]).toEqual([0, 0])
    expect([...series.y.slice(-2)]).toEqual([0, 0])
  })

  it.each([2, 8, 32])('buckets every backward vertex at its own timestamp with %s columns', (columns) => {
    const time = asFullResolution(Float64Array.from([0, 1, 0.25, 3, 4]))
    const values = asFullResolution(Float64Array.from([0, 1, 999, 3, 4]))
    const series = decimateToGrid(buildDisplayGrid(0, 4, columns), time, values)
    expect(series.sourceLength).toBe(5)
    expect(series.y[Math.floor((0.25 / 4) * columns) * 2 + 1]).toBe(999)
    expect(series.y.every(Number.isFinite)).toBe(true)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'keeps the adjacent finite segment after an earlier timestamp break (%s) when zoomed',
    (missingTime) => {
      const time = asFullResolution(Float64Array.from([0, missingTime, 1, 3, 4]))
      const values = asFullResolution(Float64Array.from([0, 999, 1, 3, 4]))
      const grid = buildDisplayGrid(1.5, 2.5, 4)
      const series = decimateToGrid(grid, time, values)
      expect([...series.y]).toEqual([...grid.x])
      expect(series.sourceLength).toBe(0)
      const wider = decimateToGrid(buildDisplayGrid(1.5, 4, 10), time, values)
      expect(wider.y.every(Number.isFinite)).toBe(true)
      expect(wider.sourceLength).toBe(2)
    },
  )

  it('interpolates a backward segment across the viewport without crossing missing vertices', () => {
    const time = asFullResolution(Float64Array.from([4, 0, Number.NaN, 4, 0]))
    const grid = buildDisplayGrid(1, 3, 8)
    const drawn = decimateToGrid(grid, time, asFullResolution(Float64Array.from([4, 0, 999, Number.NaN, 0])))
    expect([...drawn.y]).toEqual([...grid.x])
    const missing = decimateToGrid(
      grid,
      time,
      asFullResolution(Float64Array.from([4, Number.NaN, 999, 4, Number.NaN])),
    )
    expect(missing.y.every(Number.isNaN)).toBe(true)
  })

  it('does not use a missing timestamp before the viewport as an anchor', () => {
    const time = asFullResolution(Float64Array.from([0, Number.NaN, 2, 3]))
    const values = asFullResolution(Float64Array.from([0, 999, 2, 3]))
    const series = decimateToGrid(buildDisplayGrid(1, 3, 8), time, values)
    expect(series.sourceLength).toBe(2)
    expect(series.y.slice(0, 8).every(Number.isNaN)).toBe(true)
  })

  it.each([2, 600, 8192])('draws every overlapping branch through empty columns (%s columns)', (columns) => {
    // Three segments cover the whole viewport — a lower branch, a diagonal,
    // and an upper branch. Matplotlib draws all three; keeping only the
    // furthest-reaching bracket collapses the viewport to the lower branch.
    const time = asFullResolution(Float64Array.from([0, 10, 0, 10]))
    const values = asFullResolution(Float64Array.from([0, 0, 10, 10]))
    const series = decimateToGrid(buildDisplayGrid(2, 8, columns), time, values)
    const finite = [...series.y].filter(Number.isFinite)
    expect(Math.min(...finite)).toBe(0)
    expect(Math.max(...finite)).toBe(10)
  })

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
    // 0.000 to 0.500 inclusive, including the viewport's final boundary.
    expect(decimateToGrid(grid, time, values).sourceLength).toBe(501)
  })

  it('handles an empty series without throwing', () => {
    const empty = asFullResolution(new Float64Array(0))
    const grid = buildDisplayGrid(0, 1, 10)
    const series = decimateToGrid(grid, empty, empty)
    expect(series.sourceLength).toBe(0)
    expect(series.y.every((value) => Number.isNaN(value))).toBe(true)
  })

  it('keeps visible vertices even after a leading timestamp beyond the viewport', () => {
    const time = asFullResolution(Float64Array.from([9, 0, 1, 2, 3, 4]))
    const values = asFullResolution(Float64Array.from([9, 0, 1, 2, 3, 4]))
    const grid = buildDisplayGrid(2.5, 4.5, 10)
    const series = decimateToGrid(grid, time, values)
    expect(series.sourceLength).toBe(2)
    expect(series.y.every(Number.isFinite)).toBe(true)
    expect([...series.y]).toContain(3)
    expect([...series.y]).toContain(4)
  })
})
