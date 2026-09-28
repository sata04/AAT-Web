import type uPlot from 'uplot'
import { type DisplayGrid, decimateToGrid } from './decimate.ts'
import type { PlotTrace } from './plot-model.ts'
import type { AxisBounds } from './selection.ts'

/** uPlot requires null gaps; NaN is data and poisons its automatic y ranges. */
export function dataForUPlot(grid: DisplayGrid, traces: readonly PlotTrace[]): uPlot.AlignedData {
  return [
    // The generated shared x grid is finite and ordered, including across y
    // gaps. uPlot accepts a typed x array alongside null-marked ordinary y arrays.
    grid.x,
    ...traces.map((trace) =>
      Array.from(decimateToGrid(grid, trace.time, trace.values).y, (value) =>
        Number.isFinite(value) ? value : null,
      ),
    ),
  ]
}

/** Never zoom in past this span; below it floating point stops being helpful. */
const MIN_SPAN = 1e-6

export function clampViewport(viewport: AxisBounds, bounds: AxisBounds): AxisBounds {
  const boundsSpan = Math.max(bounds.max - bounds.min, MIN_SPAN)
  let span = Math.min(Math.max(viewport.max - viewport.min, MIN_SPAN), boundsSpan)
  let min = viewport.min
  if (min < bounds.min) min = bounds.min
  if (min + span > bounds.max) min = bounds.max - span
  if (min < bounds.min) {
    min = bounds.min
    span = boundsSpan
  }
  return { min, max: min + span }
}

/** Called only on drag completion; controlled setScale updates never enter here. */
export function finishDragZoom(
  plot: Pick<uPlot, 'select' | 'posToVal' | 'setSelect'>,
  bounds: AxisBounds,
  onViewportChange: (viewport: AxisBounds) => void,
): void {
  const { left, width } = plot.select
  if (width <= 0) return
  const min = plot.posToVal(left, 'x')
  const max = plot.posToVal(left + width, 'x')
  if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
    onViewportChange(clampViewport({ min, max }, bounds))
  }
  // Clearing the rectangle must not fire setSelect recursively.
  plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false)
}
