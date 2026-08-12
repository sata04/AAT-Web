/**
 * Range selection — the replacement for Matplotlib's `SpanSelector`.
 *
 * uPlot has no equivalent widget, so the behaviour the desktop relied on is
 * rebuilt here: drag to create a span, drag its edges to resize, drag from
 * anywhere inside it to move it (`drag_from_anywhere=True` in
 * `plot_controller.py`), and type exact bounds when the mouse is not precise
 * enough.
 *
 * Everything in this module is pure arithmetic over data coordinates. Pointer
 * and touch plumbing lives in the component; keeping the maths separate is what
 * makes it testable without a DOM, and what keeps "which sample is inside the
 * selection" from being decided by pixel rounding.
 */

import type { FullResolutionArray } from '../analysis/series.ts'

/**
 * Drags shorter than this are ignored — `if xmax - xmin < 0.001: return` in
 * `MainWindow.on_select_range`.
 *
 * It is not a UI nicety: a click registers as a zero-width drag, and a span of
 * one or two samples produces a standard deviation of ~0 that looks like a
 * spectacular result. Refusing the selection is more honest than reporting it.
 */
export const MIN_SELECTION_SECONDS = 0.001

export interface SelectionRange {
  readonly xMin: number
  readonly xMax: number
}

/** Which part of an existing selection a pointer is acting on. */
export type SelectionHandle = 'start' | 'end' | 'body'

export interface AxisBounds {
  readonly min: number
  readonly max: number
}

/** Order two drag endpoints. A drag right-to-left selects the same span. */
export function normaliseRange(a: number, b: number): SelectionRange {
  return a <= b ? { xMin: a, xMax: b } : { xMin: b, xMax: a }
}

/** Width in seconds. */
export function rangeWidth(range: SelectionRange): number {
  return range.xMax - range.xMin
}

/**
 * Whether a selection is worth computing statistics for.
 *
 * Non-finite endpoints are rejected too, which is what a numeric input left
 * half-typed produces.
 */
export function isSelectionUsable(range: SelectionRange): boolean {
  if (!Number.isFinite(range.xMin) || !Number.isFinite(range.xMax)) return false
  return rangeWidth(range) >= MIN_SELECTION_SECONDS
}

/** Keep a selection inside the plotted axis without changing its width if possible. */
export function clampRange(range: SelectionRange, bounds: AxisBounds): SelectionRange {
  const xMin = Math.min(Math.max(range.xMin, bounds.min), bounds.max)
  const xMax = Math.min(Math.max(range.xMax, bounds.min), bounds.max)
  return normaliseRange(xMin, xMax)
}

/**
 * Decide what a pointer at `x` would grab.
 *
 * `tolerance` is a distance in data units, computed by the caller from a pixel
 * radius, so the grab area stays a constant size on screen at every zoom level.
 * Edges win over the body: at a narrow selection the two overlap, and resizing
 * is the operation the user is reaching for.
 */
export function hitTestSelection(
  range: SelectionRange,
  x: number,
  tolerance: number,
): SelectionHandle | null {
  const startDistance = Math.abs(x - range.xMin)
  const endDistance = Math.abs(x - range.xMax)
  if (startDistance <= tolerance || endDistance <= tolerance) {
    return startDistance <= endDistance ? 'start' : 'end'
  }
  if (x > range.xMin && x < range.xMax) return 'body'
  return null
}

/**
 * Move one edge to `x`.
 *
 * Dragging an edge past the opposite one flips which edge is being held, the
 * same way the desktop's interactive span behaves — the alternative is a
 * selection that refuses to move once it is collapsed.
 */
export function resizeSelection(
  range: SelectionRange,
  handle: 'start' | 'end',
  x: number,
  bounds: AxisBounds,
): SelectionRange {
  const anchor = handle === 'start' ? range.xMax : range.xMin
  return clampRange(normaliseRange(anchor, x), bounds)
}

/**
 * Slide the whole selection by `delta` seconds.
 *
 * The width is preserved: hitting the end of the axis stops the selection there
 * rather than squashing it, which is what makes "drag from anywhere inside"
 * feel like moving an object instead of resizing one.
 */
export function moveSelection(range: SelectionRange, delta: number, bounds: AxisBounds): SelectionRange {
  const width = rangeWidth(range)
  let xMin = range.xMin + delta
  if (xMin < bounds.min) xMin = bounds.min
  if (xMin + width > bounds.max) xMin = bounds.max - width
  // A selection wider than the axis cannot be placed inside it; pin it to the
  // start rather than producing an inverted range.
  if (xMin < bounds.min) xMin = bounds.min
  return { xMin, xMax: xMin + width }
}

export interface RangeSlice {
  /** Index of the first sample inside the range, or -1 when there are none. */
  readonly startIndex: number
  /** Index one past the last sample inside the range. */
  readonly endIndex: number
  readonly count: number
}

/**
 * Locate the samples inside a selection.
 *
 * The test is inclusive at both ends — `(time >= xmin) & (time <= xmax)` in
 * `MainWindow.calculate_selected_range_statistics`. Inclusive matters at the
 * sampling rates involved here: at 1 kHz an exclusive bound routinely drops the
 * boundary sample, and a selection typed as exactly 0.100 to 0.200 would then
 * cover 99 intervals rather than 100.
 *
 * The scan is linear rather than a binary search because a sensor's time axis is
 * only *usually* monotonic — `validateTimeAxis` warns about backwards steps
 * instead of rejecting them, so a bisection could silently miss samples in a
 * disturbed recording.
 */
export function sliceForRange(time: FullResolutionArray, range: SelectionRange): RangeSlice {
  let startIndex = -1
  let endIndex = 0
  let count = 0
  for (let index = 0; index < time.length; index++) {
    const value = time[index] as number
    if (value >= range.xMin && value <= range.xMax) {
      if (startIndex < 0) startIndex = index
      endIndex = index + 1
      count++
    }
  }
  return { startIndex, endIndex, count }
}

/**
 * Collect the values whose timestamp falls inside the selection.
 *
 * Takes the *full-resolution* arrays by type: `calculateRangeStatistics` must
 * never see decimated samples, and the branded parameter is what enforces it.
 * The result carries the brand too, because it is a subset of original samples
 * rather than a summary of them.
 */
export function valuesInRange(
  time: FullResolutionArray,
  values: FullResolutionArray,
  range: SelectionRange,
): FullResolutionArray {
  const length = Math.min(time.length, values.length)
  const collected = new Float64Array(length)
  let written = 0
  for (let index = 0; index < length; index++) {
    const at = time[index] as number
    if (at >= range.xMin && at <= range.xMax) {
      collected[written++] = values[index] as number
    }
  }
  return collected.slice(0, written) as FullResolutionArray
}

/** In-progress pointer interaction. */
export type SelectionDrag =
  | { readonly kind: 'create'; readonly origin: number; readonly current: number }
  | { readonly kind: 'resize'; readonly handle: 'start' | 'end'; readonly range: SelectionRange }
  | {
      readonly kind: 'move'
      readonly origin: number
      readonly originalRange: SelectionRange
      readonly range: SelectionRange
    }

/** Start an interaction from a pointer press at `x`. */
export function beginDrag(existing: SelectionRange | null, x: number, tolerance: number): SelectionDrag {
  if (existing !== null) {
    const handle = hitTestSelection(existing, x, tolerance)
    if (handle === 'start' || handle === 'end') return { kind: 'resize', handle, range: existing }
    if (handle === 'body') return { kind: 'move', origin: x, originalRange: existing, range: existing }
  }
  return { kind: 'create', origin: x, current: x }
}

/** Advance an interaction to a new pointer position. */
export function updateDrag(drag: SelectionDrag, x: number, bounds: AxisBounds): SelectionDrag {
  switch (drag.kind) {
    case 'create':
      return { kind: 'create', origin: drag.origin, current: x }
    case 'resize':
      return {
        kind: 'resize',
        handle: drag.handle,
        range: resizeSelection(drag.range, drag.handle, x, bounds),
      }
    case 'move':
      return {
        kind: 'move',
        origin: drag.origin,
        originalRange: drag.originalRange,
        range: moveSelection(drag.originalRange, x - drag.origin, bounds),
      }
  }
}

/** The range an in-progress interaction currently describes. */
export function dragRange(drag: SelectionDrag, bounds: AxisBounds): SelectionRange {
  if (drag.kind === 'create') return clampRange(normaliseRange(drag.origin, drag.current), bounds)
  return drag.range
}

/**
 * Finish an interaction.
 *
 * A new selection that is too short is discarded (`null`), reproducing the
 * desktop's early return. Resizing or moving an existing selection below the
 * threshold keeps the previous range instead of destroying it: the user was
 * adjusting something they already had, and silently deleting it on a clumsy
 * drag is the more surprising outcome.
 */
export function commitDrag(
  drag: SelectionDrag,
  previous: SelectionRange | null,
  bounds: AxisBounds,
): SelectionRange | null {
  const candidate = dragRange(drag, bounds)
  if (isSelectionUsable(candidate)) return candidate
  return drag.kind === 'create' ? null : previous
}
