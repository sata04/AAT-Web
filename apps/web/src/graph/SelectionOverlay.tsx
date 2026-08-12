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
import { type ChartGeometry, pixelsToSpan, pixelToValue, valueToPixel } from './geometry.ts'
import {
  beginDrag,
  commitDrag,
  dragRange,
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
}

export function SelectionOverlay(props: SelectionOverlayProps): React.JSX.Element | null {
  const { geometry, selection, onSelectionChange, enabled } = props
  const [drag, setDrag] = useState<SelectionDrag | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)

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

  const valueAt = useCallback((clientX: number): number | null => {
    const layer = layerRef.current
    const currentGeometry = geometryRef.current
    if (layer === null || currentGeometry === null) return null
    const rect = layer.getBoundingClientRect()
    return pixelToValue(currentGeometry, clientX - rect.left)
  }, [])

  useEffect(() => {
    const layer = layerRef.current
    if (layer === null || !enabled) return

    const onPointerDown = (event: PointerEvent) => {
      // Shift-drag and the middle button belong to panning; a secondary click
      // belongs to the context menu.
      if (event.button !== 0 || event.shiftKey) return
      const currentGeometry = geometryRef.current
      const value = valueAt(event.clientX)
      if (currentGeometry === null || value === null) return
      event.preventDefault()
      layer.setPointerCapture(event.pointerId)
      const tolerance = pixelsToSpan(currentGeometry, HANDLE_TOLERANCE_PX)
      setDrag(beginDrag(selectionRef.current, value, tolerance))
    }

    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current
      const currentGeometry = geometryRef.current
      if (current === null || currentGeometry === null) return
      const value = valueAt(event.clientX)
      if (value === null) return
      setDrag(updateDrag(current, value, { min: currentGeometry.xMin, max: currentGeometry.xMax }))
    }

    const finish = (event: PointerEvent) => {
      const current = dragRef.current
      const currentGeometry = geometryRef.current
      if (current === null || currentGeometry === null) return
      setDrag(null)
      if (layer.hasPointerCapture(event.pointerId)) layer.releasePointerCapture(event.pointerId)
      onChangeRef.current(
        commitDrag(current, selectionRef.current, {
          min: currentGeometry.xMin,
          max: currentGeometry.xMax,
        }),
      )
    }

    layer.addEventListener('pointerdown', onPointerDown)
    layer.addEventListener('pointermove', onPointerMove)
    layer.addEventListener('pointerup', finish)
    layer.addEventListener('pointercancel', finish)

    return () => {
      layer.removeEventListener('pointerdown', onPointerDown)
      layer.removeEventListener('pointermove', onPointerMove)
      layer.removeEventListener('pointerup', finish)
      layer.removeEventListener('pointercancel', finish)
    }
  }, [enabled, valueAt])

  if (geometry === null) return null

  const bounds = { min: geometry.xMin, max: geometry.xMax }
  const shown = drag !== null ? dragRange(drag, bounds) : selection

  return (
    <div
      className="selection-overlay"
      ref={layerRef}
      style={{
        // The layer covers the whole chart root but only accepts pointers over
        // the plot area, so the axes stay clickable for focus and text
        // selection. `touch-action: none` stops the browser from turning a
        // horizontal drag into a page scroll.
        pointerEvents: enabled ? 'auto' : 'none',
        touchAction: enabled ? 'none' : 'auto',
        // Crosshair while idle, grabbing while moving a selection. The edge
        // grips set their own `ew-resize` in CSS, since they are real elements.
        cursor: drag?.kind === 'move' ? 'grabbing' : 'crosshair',
      }}
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
