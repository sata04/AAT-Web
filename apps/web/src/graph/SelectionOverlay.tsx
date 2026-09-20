/**
 * The range-selection overlay.
 *
 * Matplotlib gave the desktop an interactive `SpanSelector` with
 * `drag_from_anywhere=True`; uPlot has nothing equivalent, so the behaviour is
 * rebuilt: drag on empty plot area to create a span, drag an edge to resize,
 * drag from inside to move, and the whole thing works with a finger as well as a
 * mouse because every handler is a pointer event and the grips are 11 px wide
 * rather than 1 px.
 *
 * All the arithmetic lives in `selection.ts` and `geometry.ts`. This component
 * only translates pointer positions into calls and paints the result.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { type ChartGeometry, pixelsToSpan, valueToPixel } from './geometry.ts'
import {
  beginDrag,
  commitDrag,
  dragRange,
  hitTestSelection,
  type SelectionDrag,
  type SelectionRange,
  updateDrag,
} from './selection.ts'

/** Grab radius around an edge, in CSS pixels. Comfortable for a fingertip. */
const HANDLE_TOLERANCE_PX = 8

export interface SelectionOverlayProps {
  geometry: ChartGeometry | null
  selection: SelectionRange | null
  /** Null clears the selection — a too-short new drag, or the clear button. */
  onSelectionChange: (range: SelectionRange | null) => void
  /**
   * Disabled in comparison, show-all and G-quality views, exactly as the desktop
   * disables it: `plot_gravity_level` is the only draw path that attaches a
   * `SpanSelector`, every other one calls `clear_span_selectors()`.
   */
  enabled: boolean
  /**
   * uPlot's `.u-over` element — the plot-area event layer, published by
   * `UPlotChart` once the plot exists.
   *
   * The overlay's pointer handlers bind there rather than on the overlay div:
   * the overlay sits above the chart for painting, so making *it* the event
   * layer would swallow wheel-zoom, Shift-drag pan and middle-drag pan before
   * they reached the chart. `over` is exactly the plot rectangle, which also
   * makes axes unreachable to selection — a drag starting on a tick label can
   * no longer create a junk span clamped to the plot edge.
   */
  gestureLayer: HTMLElement | null
}

export function SelectionOverlay(props: SelectionOverlayProps): React.JSX.Element | null {
  const { geometry, selection, onSelectionChange, enabled, gestureLayer } = props
  const [drag, setDrag] = useState<SelectionDrag | null>(null)

  // Refs so the pointer handlers, which are attached once, always see current
  // values instead of the render they were created in.
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const dragRef = useRef(drag)
  dragRef.current = drag
  const onChangeRef = useRef(onSelectionChange)
  onChangeRef.current = onSelectionChange

  // `gestureLayer` is uPlot's `over`: its bounding rect is exactly the plot
  // area, so a client position maps to a data value with no axis-offset maths.
  const valueAt = useCallback(
    (clientX: number): number | null => {
      const currentGeometry = geometryRef.current
      if (gestureLayer === null || currentGeometry === null) return null
      const rect = gestureLayer.getBoundingClientRect()
      if (rect.width === 0) return null
      const span = currentGeometry.xMax - currentGeometry.xMin
      return currentGeometry.xMin + ((clientX - rect.left) / rect.width) * span
    },
    [gestureLayer],
  )

  useEffect(() => {
    const target = gestureLayer
    if (target === null || !enabled) return

    const onPointerDown = (event: PointerEvent) => {
      // Shift-drag and the middle button belong to panning; a secondary click
      // belongs to the context menu.
      if (event.button !== 0 || event.shiftKey) return
      const currentGeometry = geometryRef.current
      const value = valueAt(event.clientX)
      if (currentGeometry === null || value === null) return
      event.preventDefault()
      target.setPointerCapture(event.pointerId)
      const tolerance = pixelsToSpan(currentGeometry, HANDLE_TOLERANCE_PX)
      const next = beginDrag(selectionRef.current, value, tolerance)
      setDrag(next)
      target.style.cursor =
        next.kind === 'move' ? 'grabbing' : next.kind === 'resize' ? 'ew-resize' : 'crosshair'
    }

    const onPointerMove = (event: PointerEvent) => {
      const currentGeometry = geometryRef.current
      if (currentGeometry === null) return
      const value = valueAt(event.clientX)
      if (value === null) return

      const current = dragRef.current
      if (current === null) {
        // No drag in progress: the cursor is the affordance for what a press
        // would grab — an edge resizes, the body moves, empty area creates.
        const existing = selectionRef.current
        const tolerance = pixelsToSpan(currentGeometry, HANDLE_TOLERANCE_PX)
        const handle = existing === null ? null : hitTestSelection(existing, value, tolerance)
        target.style.cursor =
          handle === 'start' || handle === 'end' ? 'ew-resize' : handle === 'body' ? 'grab' : 'crosshair'
        return
      }
      setDrag(updateDrag(current, value, { min: currentGeometry.xMin, max: currentGeometry.xMax }))
    }

    const finish = (event: PointerEvent) => {
      const current = dragRef.current
      const currentGeometry = geometryRef.current
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
      if (current === null || currentGeometry === null) return
      setDrag(null)
      onChangeRef.current(
        commitDrag(current, selectionRef.current, {
          min: currentGeometry.xMin,
          max: currentGeometry.xMax,
        }),
      )
      target.style.cursor = 'crosshair'
    }

    // A horizontal touch drag must not become a page scroll.
    target.style.touchAction = 'none'
    target.style.cursor = 'crosshair'
    target.addEventListener('pointerdown', onPointerDown)
    target.addEventListener('pointermove', onPointerMove)
    target.addEventListener('pointerup', finish)
    target.addEventListener('pointercancel', finish)

    return () => {
      target.style.touchAction = ''
      target.style.cursor = ''
      target.removeEventListener('pointerdown', onPointerDown)
      target.removeEventListener('pointermove', onPointerMove)
      target.removeEventListener('pointerup', finish)
      target.removeEventListener('pointercancel', finish)
    }
  }, [enabled, valueAt, gestureLayer])

  if (geometry === null) return null

  const bounds = { min: geometry.xMin, max: geometry.xMax }
  const shown = drag !== null ? dragRange(drag, bounds) : selection

  return (
    <div
      className="selection-overlay"
      // Purely visual now — the gestures live on the chart's own event layer,
      // so zoom, pan and axis interactions are never shadowed.
      style={{ pointerEvents: 'none' }}
    >
      {shown === null ? null : (
        <>
          <div
            className="selection-overlay__band"
            style={{
              left: `${valueToPixel(geometry, shown.xMin)}px`,
              width: `${Math.max(0, valueToPixel(geometry, shown.xMax) - valueToPixel(geometry, shown.xMin))}px`,
              top: `${geometry.top}px`,
              height: `${geometry.height}px`,
            }}
          />
          <div
            className="selection-overlay__handle"
            style={{
              left: `${valueToPixel(geometry, shown.xMin)}px`,
              top: `${geometry.top}px`,
              height: `${geometry.height}px`,
            }}
          />
          <div
            className="selection-overlay__handle"
            style={{
              left: `${valueToPixel(geometry, shown.xMax)}px`,
              top: `${geometry.top}px`,
              height: `${geometry.height}px`,
            }}
          />
        </>
      )}
    </div>
  )
}
