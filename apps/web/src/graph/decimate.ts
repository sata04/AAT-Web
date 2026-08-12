/**
 * Min/max-per-column decimation, for rendering only.
 *
 * A 20-second run at 1 kHz is 20,000 samples drawn onto maybe 1,200 device
 * pixels. Handing all of them to Canvas is wasted work — but *which* samples are
 * dropped decides whether the picture is still true. Stride sampling (take every
 * nth) silently deletes the release shock and any single-sample spike, which in
 * this application is precisely the feature an operator is looking for. Taking
 * the minimum and the maximum of each pixel column instead preserves the
 * vertical envelope: every extreme survives, in the column where it happened.
 *
 * Decimation is onto a **shared time grid** rather than onto each sensor's own
 * samples, for a structural reason: uPlot draws every series against one x
 * array, and in AAT the Inner Capsule and the Drag Shield carry *different* time
 * axes (each is zeroed at its own sync point). Without a common grid the two
 * sensors could not be drawn on one plot at all.
 *
 * The result is a {@link DisplaySeries}, whose arrays are plain `Float64Array`
 * and therefore not assignable to `FullResolutionArray` (see
 * `src/analysis/series.ts`). That is the whole point: nothing that computes a
 * published number will accept this value.
 *
 * One honest limitation: the column scan assumes an ascending time axis. AAT
 * only *warns* about a non-monotonic axis rather than rejecting it, so such a
 * recording draws approximately. It never computes approximately — statistics,
 * G-quality, range statistics and every export read the full-resolution arrays,
 * which this module cannot reach.
 */

import type { FullResolutionArray } from '../analysis/series.ts'

declare const DISPLAY_SERIES: unique symbol

/** The shared x axis every trace on one plot is decimated onto. */
export interface DisplayGrid {
  /** Two positions per column, so a column can show both its extremes. */
  readonly x: Float64Array
  readonly columns: number
  readonly xMin: number
  readonly xMax: number
}

/**
 * Values prepared for drawing, and for nothing else.
 *
 * Deliberately not a bare array: the nominal marker means a `DisplaySeries`
 * cannot be mistaken for a sensor series anywhere, and `y` is unbranded so it
 * cannot reach a statistics or export call either.
 */
export interface DisplaySeries {
  readonly [DISPLAY_SERIES]: true
  /** Aligned to `grid.x`; NaN marks a position this sensor did not measure. */
  readonly y: Float64Array
  readonly grid: DisplayGrid
  /** How many source samples fell inside the grid's range. */
  readonly sourceLength: number
}

/** Fewer columns than this is not a plot; more than a screen's width is waste. */
const MIN_COLUMNS = 2
const MAX_COLUMNS = 8192

/**
 * Build the shared grid for a viewport.
 *
 * Each column contributes two x positions, at a quarter and three quarters
 * across it. Placing them inside the column rather than on its edges keeps
 * consecutive columns from sharing an x value, which would make two distinct
 * samples collapse into one vertical line.
 */
export function buildDisplayGrid(xMin: number, xMax: number, columns: number): DisplayGrid {
  const safeColumns = Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(columns)))
  // A degenerate range would divide by zero; widen it to something drawable.
  const span = xMax > xMin ? xMax - xMin : 1
  const start = xMax > xMin ? xMin : xMin - 0.5
  const step = span / safeColumns

  const x = new Float64Array(safeColumns * 2)
  for (let column = 0; column < safeColumns; column++) {
    x[column * 2] = start + (column + 0.25) * step
    x[column * 2 + 1] = start + (column + 0.75) * step
  }
  return { x, columns: safeColumns, xMin: start, xMax: start + span }
}

/**
 * Decimate one sensor's samples onto a grid.
 *
 * Per column: the minimum and the maximum of the samples that fall inside it.
 * A column with no samples is filled by interpolating between its neighbours
 * when it sits inside the sensor's measured span, and left as NaN when it does
 * not. That distinction is what keeps two different things looking different —
 * a zoomed-in view where the grid is finer than the sampling interval draws a
 * continuous line, while a genuine dropout, or the region beyond a sensor's
 * data, stays visibly empty.
 */
export function decimateToGrid(
  grid: DisplayGrid,
  time: FullResolutionArray,
  values: FullResolutionArray,
): DisplaySeries {
  const y = new Float64Array(grid.x.length).fill(Number.NaN)
  const length = Math.min(time.length, values.length)
  if (length === 0) return { [DISPLAY_SERIES]: true, y, grid, sourceLength: 0 }

  const step = (grid.xMax - grid.xMin) / grid.columns
  let cursor = 0
  let counted = 0

  // Skip samples before the viewport, remembering the last one so the first
  // visible column can interpolate back to it instead of starting mid-air.
  while (cursor < length && (time[cursor] as number) < grid.xMin) cursor++
  let previousIndex = cursor > 0 ? cursor - 1 : -1

  for (let column = 0; column < grid.columns; column++) {
    const columnEnd = grid.xMin + (column + 1) * step

    let minValue = Number.POSITIVE_INFINITY
    let maxValue = Number.NEGATIVE_INFINITY
    let found = false

    while (cursor < length && (time[cursor] as number) < columnEnd) {
      const value = values[cursor] as number
      if (Number.isFinite(value)) {
        if (value < minValue) minValue = value
        if (value > maxValue) maxValue = value
        found = true
        counted++
      }
      previousIndex = cursor
      cursor++
    }

    if (found) {
      y[column * 2] = minValue
      y[column * 2 + 1] = maxValue
      continue
    }

    // No sample landed here. Interpolate only between two real samples that
    // bracket the column — never extrapolate past the ends of the data.
    const nextIndex = nextFiniteIndex(time, values, cursor, length)
    const priorIndex = previousFiniteIndex(time, values, previousIndex)
    if (priorIndex < 0 || nextIndex < 0) continue

    const x0 = time[priorIndex] as number
    const x1 = time[nextIndex] as number
    const v0 = values[priorIndex] as number
    const v1 = values[nextIndex] as number
    const denominator = x1 - x0
    for (const slot of [0, 1] as const) {
      const at = grid.x[column * 2 + slot] as number
      y[column * 2 + slot] = denominator === 0 ? v0 : v0 + ((at - x0) / denominator) * (v1 - v0)
    }
  }

  return { [DISPLAY_SERIES]: true, y, grid, sourceLength: counted }
}

function nextFiniteIndex(
  time: Float64Array,
  values: Float64Array,
  from: number,
  length: number,
): number {
  for (let index = from; index < length; index++) {
    if (Number.isFinite(values[index] as number) && Number.isFinite(time[index] as number)) return index
  }
  return -1
}

function previousFiniteIndex(time: Float64Array, values: Float64Array, from: number): number {
  for (let index = from; index >= 0; index--) {
    if (Number.isFinite(values[index] as number) && Number.isFinite(time[index] as number)) return index
  }
  return -1
}

/**
 * How many columns a viewport of `pixelWidth` device pixels deserves.
 *
 * One column per pixel is the honest ceiling — a second point in the same pixel
 * cannot be seen. Anything finer costs memory and draw time to produce a picture
 * identical to the coarser one.
 */
export function columnsForWidth(pixelWidth: number): number {
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(pixelWidth)))
}

/** Read-only accessor for the drawing layer. Nothing else should need this. */
export function displayValues(series: DisplaySeries): Float64Array {
  return series.y
}
