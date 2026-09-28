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
 * Ordered axes use a bisected column scan. Unordered axes bucket every finite
 * vertex directly, so a backward timestamp cannot hide an extreme. Both paths
 * interpolate only between adjacent finite source vertices; NaNs are breaks.
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
  for (let index = 0; index < time.length; index++) {
    const current = time[index] as number
    const previous = time[index - 1] as number
    if (!Number.isFinite(current) || (index > 0 && !(current >= previous))) {
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
  /** How many finite, placeable source samples fell inside the inclusive grid range. */
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
  // Reconstructing the requested end as start + span can round it inward.
  return { x, columns: safeColumns, xMin: start, xMax: xMax > xMin ? xMax : start + span }
}

/**
 * Decimate one sensor's samples onto a grid.
 *
 * Per column: the minimum and the maximum of the samples that fall inside it.
 * Interior columns are half-open; the final column includes `grid.xMax`.
 * A column with no samples interpolates only between adjacent, finite source
 * samples bracketing its display positions. Skipped samples break interpolation.
 * That distinction is what keeps two different things looking different —
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
  if (!isMonotonic(time)) return bucketUnorderedSamples(grid, series, y)

  const step = (grid.xMax - grid.xMin) / grid.columns
  let counted = 0

  // Skip samples before the viewport, remembering the last one so the first
  // visible column can interpolate back to it instead of starting mid-air.
  let cursor = bisectFirstVisible(series, grid.xMin)
  let previousIndex = cursor > 0 ? cursor - 1 : -1

  for (let column = 0; column < grid.columns; column++) {
    const scan = scanColumnSamples(series, {
      from: cursor,
      columnStart: grid.xMin + column * step,
      columnEnd: column === grid.columns - 1 ? grid.xMax : grid.xMin + (column + 1) * step,
      inclusiveEnd: column === grid.columns - 1,
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
    // Looking only at immediate neighbours also avoids rescanning a long
    // dropout for every empty display column.
    const nextIndex = cursor
    const priorIndex = previousIndex
    if (priorIndex < 0 || nextIndex >= series.length || nextIndex !== priorIndex + 1) continue

    interpolateColumn(grid, column, y, {
      x0: time[priorIndex] as number,
      x1: time[nextIndex] as number,
      v0: values[priorIndex] as number,
      v1: values[nextIndex] as number,
    })
  }

  return { [DISPLAY_SERIES]: true, y, grid, sourceLength: counted }
}

/** Half-open ownership, using the same boundaries as the ordered scan. */
function columnForTime(grid: DisplayGrid, at: number): number {
  const step = (grid.xMax - grid.xMin) / grid.columns
  let column = Math.max(0, Math.min(grid.columns - 1, Math.floor((at - grid.xMin) / step)))
  // Division can round a boundary into its neighbour. Comparing against the
  // shared boundary expressions keeps ownership identical on both paths.
  if (column > 0 && at < grid.xMin + column * step) column--
  else if (column < grid.columns - 1 && at >= grid.xMin + (column + 1) * step) column++
  return column
}

/**
 * O(samples + columns), with no sorting or repeated walks over the input.
 * Every finite vertex contributes to its own bucket, including backward steps.
 * For empty buckets, record adjacent finite segments at their leftmost column
 * and sweep their coverage. Keeping the furthest-reaching segment is enough to
 * find a real interpolation bracket wherever one exists, without rescanning
 * overlapping segments for each column. Populated buckets retain their exact
 * vertex extrema; an empty bucket follows one covering segment.
 */
function bucketUnorderedSamples(grid: DisplayGrid, series: SeriesWindow, y: Float64Array): DisplaySeries {
  const brackets: (ColumnBracket | undefined)[] = new Array(grid.columns)
  let counted = 0
  let previous: { at: number; value: number } | undefined
  for (let index = 0; index < series.length; index++) {
    const at = series.time[index] as number
    const value = series.values[index] as number
    if (!Number.isFinite(at) || !Number.isFinite(value)) {
      previous = undefined
      continue
    }
    if (at >= grid.xMin && at <= grid.xMax) {
      const slot = columnForTime(grid, at) * 2
      y[slot] = Number.isNaN(y[slot]) ? value : Math.min(y[slot] as number, value)
      y[slot + 1] = Number.isNaN(y[slot + 1]) ? value : Math.max(y[slot + 1] as number, value)
      counted++
    }
    if (previous !== undefined && previous.at !== at) {
      const bracket =
        previous.at < at
          ? { x0: previous.at, v0: previous.value, x1: at, v1: value }
          : { x0: at, v0: value, x1: previous.at, v1: previous.value }
      if (bracket.x1 >= grid.xMin && bracket.x0 <= grid.xMax) {
        const column = columnForTime(grid, bracket.x0)
        const existing = brackets[column]
        if (existing === undefined || bracket.x1 > existing.x1) brackets[column] = bracket
      }
    }
    previous = { at, value }
  }

  let covering: ColumnBracket | undefined
  for (let column = 0; column < grid.columns; column++) {
    const bracket = brackets[column]
    if (bracket !== undefined && (covering === undefined || bracket.x1 > covering.x1)) covering = bracket
    if (Number.isNaN(y[column * 2]) && covering !== undefined) interpolateColumn(grid, column, y, covering)
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
  readonly columnStart: number
  readonly columnEnd: number
  readonly inclusiveEnd: boolean
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
  /** Last covered sample, or -1 after an unplaceable timestamp. */
  readonly previousIndex: number
}

function scanColumnSamples(series: SeriesWindow, bounds: ColumnScanBounds): ColumnScan {
  let minValue = Number.POSITIVE_INFINITY
  let maxValue = Number.NEGATIVE_INFINITY
  let counted = 0
  let cursor = bounds.from
  let previousIndex = bounds.previousIndex
  while (cursor < series.length) {
    const at = series.time[cursor] as number
    if (!Number.isFinite(at) || at < bounds.columnStart) {
      // A missing or backward timestamp cannot belong to this column or act
      // as an interpolation anchor, but must not block later valid samples.
      previousIndex = -1
      cursor++
      continue
    }
    if (at > bounds.columnEnd || (at === bounds.columnEnd && !bounds.inclusiveEnd)) break
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
 * Invalid neighbours and positions outside their span remain missing; neither
 * an explicit dropout nor an unordered timestamp permits extrapolation.
 */
function interpolateColumn(grid: DisplayGrid, column: number, y: Float64Array, bracket: ColumnBracket): void {
  const denominator = bracket.x1 - bracket.x0
  if (
    !Number.isFinite(bracket.x0) ||
    !Number.isFinite(bracket.x1) ||
    !Number.isFinite(bracket.v0) ||
    !Number.isFinite(bracket.v1) ||
    denominator <= 0
  )
    return
  for (const slot of [0, 1] as const) {
    const at = grid.x[column * 2 + slot] as number
    if (at < bracket.x0 || at > bracket.x1) continue
    y[column * 2 + slot] = bracket.v0 + ((at - bracket.x0) / denominator) * (bracket.v1 - bracket.v0)
  }
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
