import type uPlot from 'uplot'
import { describe, expect, it, vi } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import { buildDisplayGrid } from '../../src/graph/decimate.ts'
import type { PlotTrace } from '../../src/graph/plot-model.ts'
import { dataForUPlot, finishDragZoom } from '../../src/graph/uplot-adapter.ts'

function trace(axis: PlotTrace['axis'], time: number[], values: number[]): PlotTrace {
  return {
    key: axis,
    label: axis,
    colour: '#0969da',
    axis,
    time: asFullResolution(Float64Array.from(time)),
    values: asFullResolution(Float64Array.from(values)),
  }
}

describe('uPlot data boundary', () => {
  it('keeps the shared finite x grid and converts missing values on both y axes to null', () => {
    const grid = buildDisplayGrid(0, 4, 8)
    const primary = trace('y', [0, 1, 2, 3, 4], [0, Number.NaN, Number.NaN, Number.NaN, 0])
    const secondary = trace('y2', [1, 2, 3], [10, 20, 30])
    const data = dataForUPlot(grid, [primary, secondary])

    expect(data[0]).toBe(grid.x)
    expect(data[0].every(Number.isFinite)).toBe(true)
    expect(data[1]?.slice(2, -2)).toEqual(Array(12).fill(null))
    expect(data[2]?.slice(0, 4)).toEqual([null, null, null, null])
    expect(data[2]?.slice(-2)).toEqual([null, null])
    for (const series of data.slice(1)) {
      expect(series?.length).toBe(grid.x.length)
      expect(Array.from(series ?? []).every((value) => value === null || Number.isFinite(value))).toBe(true)
    }
    expect(Number.isNaN(primary.values[1])).toBe(true)
  })

  it('keeps an entirely missing secondary series null-marked', () => {
    const data = dataForUPlot(buildDisplayGrid(0, 1, 2), [trace('y2', [0, 1], [Number.NaN, Number.NaN])])
    expect(data[1]).toEqual([null, null, null, null])
  })
})

function zoomPlot(left: number, width: number): Pick<uPlot, 'select' | 'posToVal' | 'setSelect'> {
  const select = { left, width, top: 0, height: 100 }
  return {
    select,
    // CSS positions on a 100 px plot showing [0, 10].
    posToVal: vi.fn((position: number) => position / 10),
    setSelect: vi.fn((next) => Object.assign(select, next)),
  }
}

describe('controlled drag zoom', () => {
  const bounds = { min: 0, max: 10 }

  it('publishes data coordinates and clears the rectangle without firing its hook again', () => {
    const plot = zoomPlot(20, 30)
    const publish = vi.fn()
    finishDragZoom(plot, bounds, publish)
    expect(publish).toHaveBeenCalledExactlyOnceWith({ min: 2, max: 5 })
    expect(plot.posToVal).toHaveBeenCalledWith(20, 'x')
    expect(plot.posToVal).toHaveBeenCalledWith(50, 'x')
    expect(plot.setSelect).toHaveBeenCalledWith({ left: 0, top: 0, width: 0, height: 0 }, false)

    // A subsequent hook or redraw sees the cleared rectangle and cannot feed
    // the same zoom back into controlled viewport state.
    finishDragZoom(plot, bounds, publish)
    expect(publish).toHaveBeenCalledTimes(1)
  })

  it('clamps a dragged range to the data bounds', () => {
    const publish = vi.fn()
    finishDragZoom(zoomPlot(-20, 150), bounds, publish)
    expect(publish).toHaveBeenCalledExactlyOnceWith(bounds)
  })

  it('ignores clicks and invalid scales', () => {
    const publish = vi.fn()
    finishDragZoom(zoomPlot(20, 0), bounds, publish)
    const invalid = zoomPlot(20, 30)
    invalid.posToVal = () => Number.NaN
    finishDragZoom(invalid, bounds, publish)
    expect(publish).not.toHaveBeenCalled()
  })
})
