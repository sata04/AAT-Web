/**
 * Mapping between data coordinates and CSS pixels.
 *
 * uPlot has `valToPos` / `posToVal`, but reaching into the chart instance from
 * an overlay would tie the overlay's correctness to a live canvas. The x scale
 * is linear, so the mapping is one multiplication — kept here as pure functions
 * the selection maths and its tests can use without a DOM.
 */

/** The plot area, in CSS pixels relative to the chart root, plus its x range. */
export interface ChartGeometry {
  left: number
  top: number
  width: number
  height: number
  xMin: number
  xMax: number
}

/** Data value to horizontal offset inside the chart root. */
export function valueToPixel(geometry: ChartGeometry, value: number): number {
  const span = geometry.xMax - geometry.xMin
  if (span === 0) return geometry.left
  return geometry.left + ((value - geometry.xMin) / span) * geometry.width
}

/** Horizontal offset inside the chart root back to a data value. */
export function pixelToValue(geometry: ChartGeometry, pixel: number): number {
  if (geometry.width === 0) return geometry.xMin
  const span = geometry.xMax - geometry.xMin
  return geometry.xMin + ((pixel - geometry.left) / geometry.width) * span
}

/**
 * How many data units a pixel radius covers.
 *
 * Used for the grab tolerance around a selection edge, so the target stays a
 * constant size on screen no matter how far the view is zoomed.
 */
export function pixelsToSpan(geometry: ChartGeometry, pixels: number): number {
  if (geometry.width === 0) return 0
  return ((geometry.xMax - geometry.xMin) / geometry.width) * pixels
}
