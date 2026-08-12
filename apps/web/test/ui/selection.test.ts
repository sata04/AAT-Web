/**
 * Range-selection maths.
 *
 * These cover the behaviours that decide what a reported statistic actually
 * measured: the 0.001 s floor the desktop applies, the inclusive bounds, and
 * what happens when a selection is edited rather than created.
 */

import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import { pixelsToSpan, pixelToValue, valueToPixel } from '../../src/graph/geometry.ts'
import {
  beginDrag,
  clampRange,
  commitDrag,
  dragRange,
  hitTestSelection,
  isSelectionUsable,
  MIN_SELECTION_SECONDS,
  moveSelection,
  normaliseRange,
  rangeWidth,
  resizeSelection,
  sliceForRange,
  updateDrag,
  valuesInRange,
} from '../../src/graph/selection.ts'

const BOUNDS = { min: 0, max: 1.45 }

describe('normalisation', () => {
  it('orders a right-to-left drag the same as left-to-right', () => {
    expect(normaliseRange(0.8, 0.2)).toEqual({ xMin: 0.2, xMax: 0.8 })
    expect(normaliseRange(0.2, 0.8)).toEqual({ xMin: 0.2, xMax: 0.8 })
  })

  it('clamps to the axis without inverting the range', () => {
    const clamped = clampRange({ xMin: -3, xMax: 9 }, BOUNDS)
    expect(clamped).toEqual({ xMin: 0, xMax: 1.45 })
  })
})

describe('the 0.001 s floor', () => {
  it('matches the desktop threshold exactly', () => {
    expect(MIN_SELECTION_SECONDS).toBe(0.001)
  })

  it('rejects a drag shorter than the floor', () => {
    expect(isSelectionUsable({ xMin: 0.2, xMax: 0.2005 })).toBe(false)
  })

  it('accepts a drag exactly at the floor', () => {
    // `xmax - xmin < 0.001` in the Python: equal is accepted.
    expect(isSelectionUsable({ xMin: 0.2, xMax: 0.201 })).toBe(true)
  })

  it('rejects non-finite endpoints, which a half-typed input produces', () => {
    expect(isSelectionUsable({ xMin: Number.NaN, xMax: 0.5 })).toBe(false)
    expect(isSelectionUsable({ xMin: 0, xMax: Number.POSITIVE_INFINITY })).toBe(false)
  })

  it('discards a too-short new drag but keeps an over-adjusted existing one', () => {
    const previous = { xMin: 0.2, xMax: 0.4 }

    const created = beginDrag(null, 0.3, 0)
    const tiny = updateDrag(created, 0.30005, BOUNDS)
    expect(commitDrag(tiny, null, BOUNDS)).toBeNull()

    // Resizing an existing selection into nothing must not silently delete it:
    // the user was adjusting something they already had.
    const resizing = beginDrag(previous, 0.4, 0.01)
    const collapsed = updateDrag(resizing, 0.2000001, BOUNDS)
    expect(commitDrag(collapsed, previous, BOUNDS)).toEqual(previous)
  })
})

describe('hit testing', () => {
  const range = { xMin: 0.2, xMax: 0.8 }

  it('grabs the nearer edge when both are within tolerance', () => {
    expect(hitTestSelection(range, 0.205, 0.02)).toBe('start')
    expect(hitTestSelection(range, 0.795, 0.02)).toBe('end')
  })

  it('grabs the body from anywhere inside, as drag_from_anywhere does', () => {
    expect(hitTestSelection(range, 0.5, 0.02)).toBe('body')
  })

  it('returns null outside the selection', () => {
    expect(hitTestSelection(range, 0.05, 0.02)).toBeNull()
    expect(hitTestSelection(range, 1.2, 0.02)).toBeNull()
  })

  it('prefers an edge over the body on a narrow selection where both overlap', () => {
    const narrow = { xMin: 0.5, xMax: 0.51 }
    expect(hitTestSelection(narrow, 0.505, 0.02)).not.toBe('body')
  })
})

describe('editing', () => {
  it('resizes about the opposite edge', () => {
    const range = { xMin: 0.2, xMax: 0.8 }
    expect(resizeSelection(range, 'start', 0.4, BOUNDS)).toEqual({ xMin: 0.4, xMax: 0.8 })
    expect(resizeSelection(range, 'end', 0.6, BOUNDS)).toEqual({ xMin: 0.2, xMax: 0.6 })
  })

  it('flips the held edge when dragged past the other one', () => {
    const range = { xMin: 0.2, xMax: 0.8 }
    expect(resizeSelection(range, 'start', 0.95, BOUNDS)).toEqual({ xMin: 0.8, xMax: 0.95 })
  })

  it('moves without changing the width', () => {
    const range = { xMin: 0.2, xMax: 0.5 }
    const moved = moveSelection(range, 0.3, BOUNDS)
    expect(moved).toEqual({ xMin: 0.5, xMax: 0.8 })
    expect(rangeWidth(moved)).toBeCloseTo(rangeWidth(range), 12)
  })

  it('stops at the axis edge instead of squashing', () => {
    const range = { xMin: 1.0, xMax: 1.3 }
    const moved = moveSelection(range, 10, BOUNDS)
    expect(moved.xMax).toBeCloseTo(BOUNDS.max, 12)
    expect(rangeWidth(moved)).toBeCloseTo(0.3, 12)
  })

  it('starts a move when the press lands inside an existing selection', () => {
    const existing = { xMin: 0.2, xMax: 0.8 }
    const drag = beginDrag(existing, 0.5, 0.01)
    expect(drag.kind).toBe('move')
    const dragged = updateDrag(drag, 0.6, BOUNDS)
    const moved = dragRange(dragged, BOUNDS)
    expect(moved.xMin).toBeCloseTo(0.3, 12)
    expect(moved.xMax).toBeCloseTo(0.9, 12)
  })

  it('starts a new selection when the press lands outside', () => {
    const existing = { xMin: 0.2, xMax: 0.4 }
    expect(beginDrag(existing, 0.9, 0.01).kind).toBe('create')
  })
})

describe('inclusive bounds', () => {
  // 0.000, 0.001, ... 0.010 — a 1 kHz axis, which is the frozen default.
  const time = asFullResolution(Float64Array.from({ length: 11 }, (_, index) => index / 1000))
  const values = asFullResolution(Float64Array.from({ length: 11 }, (_, index) => index))

  it('includes samples exactly on both bounds', () => {
    const collected = valuesInRange(time, values, { xMin: 0.002, xMax: 0.005 })
    // 0.002, 0.003, 0.004, 0.005 — four samples, not two.
    expect([...collected]).toEqual([2, 3, 4, 5])
  })

  it('reports the same span through sliceForRange', () => {
    const slice = sliceForRange(time, { xMin: 0.002, xMax: 0.005 })
    expect(slice).toEqual({ startIndex: 2, endIndex: 6, count: 4 })
  })

  it('returns nothing for a range beyond the data', () => {
    expect(valuesInRange(time, values, { xMin: 5, xMax: 6 }).length).toBe(0)
    expect(sliceForRange(time, { xMin: 5, xMax: 6 }).startIndex).toBe(-1)
  })

  it('carries non-finite samples through rather than dropping them', () => {
    // Dropping them here would hide the dropout; calculateRangeStatistics counts
    // them as `missing`, which is what the user needs to see.
    const gappy = asFullResolution(Float64Array.from([0, Number.NaN, 2, 3]))
    const axis = asFullResolution(Float64Array.from([0, 0.001, 0.002, 0.003]))
    const collected = valuesInRange(axis, gappy, { xMin: 0, xMax: 0.003 })
    expect(collected.length).toBe(4)
    expect(Number.isNaN(collected[1] as number)).toBe(true)
  })
})

describe('pixel mapping', () => {
  const geometry = { left: 40, top: 10, width: 400, height: 200, xMin: 0, xMax: 1 }

  it('round-trips a value through pixels', () => {
    expect(pixelToValue(geometry, valueToPixel(geometry, 0.25))).toBeCloseTo(0.25, 12)
  })

  it('places the range ends at the plot edges', () => {
    expect(valueToPixel(geometry, 0)).toBe(40)
    expect(valueToPixel(geometry, 1)).toBe(440)
  })

  it('converts a pixel radius into a data tolerance that scales with zoom', () => {
    expect(pixelsToSpan(geometry, 8)).toBeCloseTo(0.02, 12)
    // Zoomed in 10x, the same 8 px covers a tenth of the data span.
    expect(pixelsToSpan({ ...geometry, xMax: 0.1 }, 8)).toBeCloseTo(0.002, 12)
  })

  it('degrades safely on a zero-width plot rather than dividing by zero', () => {
    const degenerate = { ...geometry, width: 0 }
    expect(pixelToValue(degenerate, 100)).toBe(0)
    expect(pixelsToSpan(degenerate, 8)).toBe(0)
  })
})
