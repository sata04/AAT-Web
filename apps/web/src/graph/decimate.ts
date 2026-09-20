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

/**
 * The nominal marker.
 *
 * A real symbol, not a `declare`d phantom: it is written at runtime, and it is
 * not exported, so a `DisplaySeries` can only come from this module. That is
 * what makes the type nominal rather than merely descriptive.
 */
const DISPLAY_SERIES = Symbol('aat.displaySeries')

/**
 * Whether an axis is safe to bisect, remembered per array so a pan/zoom redraw
 * does not rescan it. Non-finite or backward steps both count as unordered —
 * the bisect's comparisons silently misclassify either.
 */
const monotonicAxes = new WeakMap<FullResolutionArray, boolean>()

function isMonotonic(time: FullResolutionArray): boolean {
  const known = monotonicAxes.get(time)
  if (known !== undefined) return known
  let sorted = true
  for (let index = 1; index < time.length; index++) {
    const current = time[index] as number
    const previous = time[index - 1] as number
    if (!(current >= previous)) {
      sorted = false
      break
    }
  }
  monotonicAxes.set(time, sorted)
  return sorted
}

/** The bisected answer for an axis already proven ordered. */
function bisectFirstVisible(series: SeriesWindow, xMin: number): number {
  let lower = 0
  let upper = series.length
  while (lower < upper) {
    const mid = (lower + upper) >>> 1
    if ((series.time[mid] as number) < xMin) lower = mid + 1
    else upper = mid
  }
  return lower
}

/** The linear answer for an unordered axis, where only input order is trustworthy. */
function scanFirstVisible(series: SeriesWindow, xMin: number): number {
  let cursor = 0
  while (cursor < series.length && (series.time[cursor] as number) < xMin) cursor++
  return cursor
}

/**
 * First index whose sample is not before `xMin`. Bisected on a monotonic axis —
 * at millions of samples a linear scan dominated every wheel tick's redraw —
 * scanned linearly when the axis steps backward, where "the prefix" does not
 * exist and only input order is trustworthy (the column loop's own assumption).
 */
function firstVisibleIndex(series: SeriesWindow, xMin: number): number {
  return isMonotonic(series.time) ? bisectFirstVisible(series, xMin) : scanFirstVisible(series, xMin)
}

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
  const series: SeriesWindow = { time, values, length: Math.min(time.length, values.length) }
  if (series.length === 0) return { [DISPLAY_SERIES]: true, y, grid, sourceLength: 0 }

  const step = (grid.xMax - grid.xMin) / grid.columns
  let counted = 0

  // Skip samples before the viewport, remembering the last one so the first
  // visible column can interpolate back to it instead of starting mid-air.
  let cursor = firstVisibleIndex(series, grid.xMin)
  let previousIndex = cursor > 0 ? cursor - 1 : -1

  for (let column = 0; column < grid.columns; column++) {
    const scan = scanColumnSamples(series, {
      from: cursor,
      columnEnd: grid.xMin + (column + 1) * step,
      previousIndex,
    })
    cursor = scan.cursor
    previousIndex = scan.previousIndex
    counted += scan.counted

    if (scan.counted > 0) {
      y[column * 2] = scan.minValue
      y[column * 2 + 1] = scan.maxValue
      continue
    }

    // No sample landed here. Interpolate only between two real samples that
    // bracket the column — never extrapolate past the ends of the data.
    const nextIndex = nextFiniteIndex(series, cursor)
    const priorIndex = previousFiniteIndex(series, previousIndex)
    if (priorIndex < 0 || nextIndex < 0) continue

    interpolateColumn(grid, column, y, {
      x0: time[priorIndex] as number,
      x1: time[nextIndex] as number,
      v0: values[priorIndex] as number,
      v1: values[nextIndex] as number,
    })
  }

  return { [DISPLAY_SERIES]: true, y, grid, sourceLength: counted }
}

/** A slice of one sensor's series, bounded by the shorter of its two arrays. */
interface SeriesWindow {
  readonly time: FullResolutionArray
  readonly values: FullResolutionArray
  readonly length: number
}

/** Where one pixel column's scan starts, ends, and what precedes it. */
interface ColumnScanBounds {
  readonly from: number
  readonly columnEnd: number
  readonly previousIndex: number
}

/** What one pixel column's scan consumed and found. */
interface ColumnScan {
  readonly minValue: number
  readonly maxValue: number
  /** Finite samples claimed — the column's extremes are worth drawing. */
  readonly counted: number
  /** One past the last sample the column's range covered. */
  readonly cursor: number
  /** The last covered sample, finite or not — interpolation reads back to it. */
  readonly previousIndex: number
}

function scanColumnSamples(series: SeriesWindow, bounds: ColumnScanBounds): ColumnScan {
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  let counted = 0
  let cursor = bounds.from
  let previousIndex = bounds.previousIndex
  while (cursor < series.length && (series.time[cursor] as number) < bounds.columnEnd) {
    const value = series.values[cursor] as number
    if (Number.isFinite(value)) {
      if (value < minValue) minValue = value
      if (value > maxValue) maxValue = value
      counted++
    }
    previousIndex = cursor
    cursor++
  }
  return { minValue, maxValue, counted, cursor, previousIndex }
}

/** The two real samples an empty column interpolates between. */
interface ColumnBracket {
  readonly x0: number
  readonly x1: number
  readonly v0: number
  readonly v1: number
}

/**
 * Fill an empty column's two positions from the samples bracketing it.
 * `denominator === 0` means the bracketing samples share one x — draw the
 * earlier value rather than dividing through it.
 */
function interpolateColumn(grid: DisplayGrid, column: number, y: Float64Array, bracket: ColumnBracket): void {
  const denominator = bracket.x1 - bracket.x0
  for (const slot of [0, 1] as const) {
    const at = grid.x[column * 2 + slot] as number
    y[column * 2 + slot] =
      denominator === 0
        ? bracket.v0
        : bracket.v0 + ((at - bracket.x0) / denominator) * (bracket.v1 - bracket.v0)
  }
}

function nextFiniteIndex(series: SeriesWindow, from: number): number {
  for (let index = from; index < series.length; index++) {
    if (Number.isFinite(series.values[index] as number) && Number.isFinite(series.time[index] as number)) {
      return index
    }
  }
  return -1
}

function previousFiniteIndex(series: SeriesWindow, from: number): number {
  for (let index = from; index >= 0; index--) {
    if (Number.isFinite(series.values[index] as number) && Number.isFinite(series.time[index] as number)) {
      return index
    }
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
