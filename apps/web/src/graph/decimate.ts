/**
 * Min/max-per-pixel decimation, for rendering only.
 *
 * A 20-second run at 1 kHz is 20,000 samples drawn onto maybe 1,200 device
 * pixels. Handing all of them to Canvas is wasted work — but *which* samples are
 * dropped decides whether the picture is still true. Stride sampling (take every
 * nth) silently deletes the release shock and any single-sample spike, which in
 * this application is exactly the feature an operator is looking for. Taking the
 * minimum and the maximum of each pixel column instead preserves the vertical
 * envelope: every extreme survives, at the pixel where it happened.
 *
 * The result is a {@link DisplaySeries}, whose arrays are plain `Float64Array`
 * and therefore not assignable to `FullResolutionArray` (see
 * `src/analysis/series.ts`). That is the whole point: nothing that computes a
 * published number will accept this value.
 */

import type { FullResolutionArray } from '../analysis/series.ts'

declare const DISPLAY_SERIES: unique symbol

/**
 * Samples prepared for drawing, and for nothing else.
 *
 * Deliberately not a bare pair of arrays: the nominal marker means a
 * `DisplaySeries` cannot be mistaken for a sensor series anywhere, and its `x` /
 * `y` are unbranded so they cannot reach a statistics or export call either.
 */
export interface DisplaySeries {
  readonly [DISPLAY_SERIES]: true
  /** Time axis of the points to draw, ascending. */
  readonly x: Float64Array
  /** Values to draw. May contain NaN, which uPlot renders as a gap. */
  readonly y: Float64Array
  /** How many source samples this was built from. */
  readonly sourceLength: number
  /** False when the source already fitted the target width and was copied as-is. */
  readonly decimated: boolean
}

function makeDisplaySeries(
  x: Float64Array,
  y: Float64Array,
  sourceLength: number,
  decimated: boolean,
): DisplaySeries {
  return { [DISPLAY_SERIES]: true, x, y, sourceLength, decimated }
}

/**
 * Below this many samples decimation costs more than it saves, and an operator
 * zoomed into a few hundred points wants to see the actual samples.
 */
const DECIMATION_FLOOR = 2

/**
 * Decimate `values` against `time` for a target pixel width.
 *
 * `targetPoints` is the number of pixel columns available. Each column
 * contributes at most two points — its minimum and its maximum — emitted in the
 * order they occur in the source so the polyline never doubles back on itself.
 *
 * Non-finite samples are carried through as NaN rather than dropped: a dropout
 * must read as a gap in the trace, not as a straight line bridging it.
 */
export function decimateForDisplay(
  time: FullResolutionArray,
  values: FullResolutionArray,
  targetPoints: number,
): DisplaySeries {
  const length = Math.min(time.length, values.length)
  if (length === 0) return makeDisplaySeries(new Float64Array(0), new Float64Array(0), 0, false)

  const columns = Math.max(DECIMATION_FLOOR, Math.floor(targetPoints))

  // Two points per column is the budget, so anything at or under that is already
  // drawable exactly. Copy rather than alias: the caller owns full-resolution
  // buffers whose lifetime is not tied to this frame.
  if (length <= columns * 2) {
    return makeDisplaySeries(time.slice(0, length), values.slice(0, length), length, false)
  }

  const outX = new Float64Array(columns * 2)
  const outY = new Float64Array(columns * 2)
  let written = 0

  for (let column = 0; column < columns; column++) {
    // Bucket bounds computed from the column index rather than accumulated, so
    // rounding cannot drift and leave the tail of the series unvisited.
    const start = Math.floor((column * length) / columns)
    const end = Math.floor(((column + 1) * length) / columns)
    if (end <= start) continue

    let minIndex = -1
    let maxIndex = -1
    let minValue = Number.POSITIVE_INFINITY
    let maxValue = Number.NEGATIVE_INFINITY
    let sawGap = false

    for (let index = start; index < end; index++) {
      const value = values[index] as number
      if (!Number.isFinite(value)) {
        sawGap = true
        continue
      }
      if (value < minValue) {
        minValue = value
        minIndex = index
      }
      if (value > maxValue) {
        maxValue = value
        maxIndex = index
      }
    }

    if (minIndex < 0) {
      // The whole column is missing data. One NaN keeps the gap visible at the
      // right place without pretending to know a value for it.
      outX[written] = time[start] as number
      outY[written] = Number.NaN
      written++
      continue
    }

    // Emit in source order: drawing max-then-min for a column whose minimum came
    // first would tilt the vertical stroke the wrong way.
    const firstIndex = Math.min(minIndex, maxIndex)
    const secondIndex = Math.max(minIndex, maxIndex)

    outX[written] = time[firstIndex] as number
    outY[written] = values[firstIndex] as number
    written++

    if (secondIndex !== firstIndex) {
      outX[written] = time[secondIndex] as number
      outY[written] = values[secondIndex] as number
      written++
    }

    if (sawGap) {
      // A column that held both real samples and dropouts still has to show the
      // dropout, otherwise a run with intermittent data reads as continuous.
      const gapTime = time[end - 1] as number
      if (gapTime > (outX[written - 1] as number)) {
        outX[written] = gapTime
        outY[written] = Number.NaN
        written++
      }
    }
  }

  return makeDisplaySeries(outX.slice(0, written), outY.slice(0, written), length, true)
}

/**
 * Decimate only the part of the series inside `[xMin, xMax]`.
 *
 * Zooming in must add detail. Decimating the whole run and then letting uPlot
 * clip would keep the zoomed view at the resolution of the full view, which is
 * the classic way a min/max plot looks blocky no matter how far you zoom.
 *
 * The window is widened by one sample on each side so the line still meets the
 * edges of the viewport instead of stopping short of them.
 */
export function decimateWindowForDisplay(
  time: FullResolutionArray,
  values: FullResolutionArray,
  xMin: number,
  xMax: number,
  targetPoints: number,
): DisplaySeries {
  const length = Math.min(time.length, values.length)
  if (length === 0) return decimateForDisplay(time, values, targetPoints)

  const start = Math.max(0, lowerBound(time, length, xMin) - 1)
  const end = Math.min(length, upperBound(time, length, xMax) + 1)
  if (end - start >= length) return decimateForDisplay(time, values, targetPoints)
  if (end <= start) return decimateForDisplay(time, values, targetPoints)

  // `subarray` views the same buffer, so no copy is made for the common case of
  // panning across a large run. The brand is preserved because these samples are
  // still every original sample in the window.
  const windowTime = time.subarray(start, end) as FullResolutionArray
  const windowValues = values.subarray(start, end) as FullResolutionArray
  return decimateForDisplay(windowTime, windowValues, targetPoints)
}

/** First index whose time is >= `x`, assuming an ascending axis. */
function lowerBound(time: Float64Array, length: number, x: number): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((time[middle] as number) < x) low = middle + 1
    else high = middle
  }
  return low
}

/** First index whose time is > `x`, assuming an ascending axis. */
function upperBound(time: Float64Array, length: number, x: number): number {
  let low = 0
  let high = length
  while (low < high) {
    const middle = (low + high) >>> 1
    if ((time[middle] as number) <= x) low = middle + 1
    else high = middle
  }
  return low
}

/** Read-only accessor for the drawing layer. Nothing else should need this. */
export function displayPoints(series: DisplaySeries): { x: Float64Array; y: Float64Array } {
  return { x: series.x, y: series.y }
}
