/**
 * The uPlot renderer.
 *
 * Thin on purpose: what to draw was already decided by `plot-model.ts`, and how
 * many points to draw is decided by `decimate.ts` against the viewport this
 * component is actually rendering into. What is left here is uPlot lifecycle,
 * resize handling, and the pointer gestures that Matplotlib's navigation toolbar
 * used to provide.
 *
 * Geometry is published to the overlay through a callback instead of the overlay
 * reaching into the uPlot instance. The x scale is linear, so a position is
 * `left + (value - xMin) / (xMax - xMin) * width` — arithmetic the overlay can
 * do itself, and can be tested without a canvas.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { buildDisplayGrid, columnsForWidth, decimateToGrid } from './decimate.ts'
import type { ChartGeometry } from './geometry.ts'
import type { PlotModel } from './plot-model.ts'
import type { GraphPalette } from './theme.ts'

/** The visible x range, in data units. */
export interface ChartViewport {
  min: number
  max: number
}

export interface UPlotChartProps {
  model: PlotModel
  palette: GraphPalette
  viewport: ChartViewport
  onViewportChange: (viewport: ChartViewport) => void
  /** Full data extent, so a zoom-out cannot wander off into empty space. */
  bounds: ChartViewport
  onGeometryChange: (geometry: ChartGeometry | null) => void
  /** Handed the drawing canvas so PNG export can read it. */
  onCanvasChange: (canvas: HTMLCanvasElement | null) => void
  /**
   * When true this component leaves left-button drags alone: the selection
   * overlay is using them. Panning then needs Shift, exactly as it does when a
   * selection tool owns the primary drag in other analysis tools.
   */
  primaryDragReserved: boolean
  children?: React.ReactNode
}

const WHEEL_ZOOM_FACTOR = 0.0015
/** Never zoom in past this span; below it floating point stops being helpful. */
const MIN_SPAN = 1e-6

function clampViewport(viewport: ChartViewport, bounds: ChartViewport): ChartViewport {
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

export function UPlotChart(props: UPlotChartProps): React.JSX.Element {
  const {
    model,
    palette,
    viewport,
    onViewportChange,
    bounds,
    onGeometryChange,
    onCanvasChange,
    primaryDragReserved,
  } = props

  const rootRef = useRef<HTMLDivElement | null>(null)
  const plotRef = useRef<uPlot | null>(null)
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 })
  const titleId = useId()

  // Refs, not state: uPlot's `range` callbacks and the wheel handler run outside
  // React's render cycle and must see the current values, not a captured render.
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const modelRef = useRef(model)
  modelRef.current = model
  const onViewportChangeRef = useRef(onViewportChange)
  onViewportChangeRef.current = onViewportChange

  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry === undefined) return
      const box = entry.contentRect
      setSize({ width: Math.floor(box.width), height: Math.floor(box.height) })
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  const publishGeometry = useCallback(() => {
    const plot = plotRef.current
    if (plot === null) {
      onGeometryChange(null)
      return
    }
    const current = viewportRef.current
    onGeometryChange({
      left: plot.bbox.left / devicePixelRatio,
      top: plot.bbox.top / devicePixelRatio,
      width: plot.bbox.width / devicePixelRatio,
      height: plot.bbox.height / devicePixelRatio,
      xMin: current.min,
      xMax: current.max,
    })
  }, [onGeometryChange])

  /**
   * Recreate the plot.
   *
   * Series, axes and palette are all baked into uPlot's options at construction
   * time, so a change to any of them means a new instance. That is cheaper than
   * it sounds — the expensive part is drawing, not constructing — and it removes
   * a whole class of bugs where a stale axis colour or a removed series survives
   * an in-place update.
   */
  useLayoutEffect(() => {
    const root = rootRef.current
    if (root === null || size.width === 0 || size.height === 0) return
    if (model.traces.length === 0) {
      onCanvasChange(null)
      onGeometryChange(null)
      return
    }

    const hasSecondAxis = model.y2Label !== null && model.traces.some((trace) => trace.axis === 'y2')

    const options: uPlot.Options = {
      width: size.width,
      height: size.height,
      // Rendered as HTML next to the plot, where it can wrap and be selected.
      title: '',
      legend: { show: false },
      cursor: {
        // uPlot's own drag-to-zoom is enabled only when the selection tool is
        // not using the primary button; otherwise the two fight over the drag.
        drag: { x: !primaryDragReserved, y: false, setScale: !primaryDragReserved },
        focus: { prox: 24 },
      },
      scales: {
        x: {
          time: false,
          // A function range keeps uPlot from auto-fitting behind our back; the
          // viewport is owned by React so the toolbar and the URL agree with it.
          range: () => [viewportRef.current.min, viewportRef.current.max],
        },
        y: {
          range: (_self, dataMin, dataMax) => {
            const fixed = modelRef.current.yRange
            if (fixed !== null) return [fixed[0], fixed[1]]
            return uPlot.rangeNum(dataMin, dataMax, 0.1, true)
          },
        },
        ...(hasSecondAxis
          ? {
              y2: {
                range: (_self, dataMin, dataMax) => uPlot.rangeNum(dataMin, dataMax, 0.1, true),
              },
            }
          : {}),
      },
      axes: [
        {
          stroke: palette.axis,
          grid: { stroke: palette.grid, width: 1, dash: [4, 4] },
          ticks: { stroke: palette.grid, width: 1 },
          font: '11px system-ui, sans-serif',
          label: model.xLabel,
          labelFont: '12px system-ui, sans-serif',
          labelSize: 26,
        },
        {
          scale: 'y',
          stroke: palette.axis,
          grid: { stroke: palette.grid, width: 1, dash: [4, 4] },
          ticks: { stroke: palette.grid, width: 1 },
          font: '11px system-ui, sans-serif',
          label: model.yLabel,
          labelFont: '12px system-ui, sans-serif',
          labelSize: 30,
        },
        ...(hasSecondAxis
          ? [
              {
                scale: 'y2',
                side: 1 as const,
                stroke: palette.axis,
                // Only one axis draws grid lines; two overlapping grids at
                // different scales read as noise.
                grid: { show: false },
                ticks: { stroke: palette.grid, width: 1 },
                font: '11px system-ui, sans-serif',
                label: model.y2Label ?? '',
                labelFont: '12px system-ui, sans-serif',
                labelSize: 30,
              },
            ]
          : []),
      ],
      series: [
        {},
        ...model.traces.map((trace) => ({
          label: trace.label,
          stroke: trace.colour,
          width: 1,
          scale: trace.axis,
          // Points would be meaningless at display resolution, where one drawn
          // point can stand for hundreds of samples.
          points: { show: false },
          spanGaps: false,
        })),
      ],
      plugins: [
        {
          hooks: {
            // Shaded spans behind the traces: show-all uses them to mark what
            // filtering kept, which is the whole reason to look at all the data.
            drawClear: (self: uPlot) => {
              const bands = modelRef.current.bands
              if (bands.length === 0) return
              const context = self.ctx
              context.save()
              context.globalAlpha = 0.1
              for (const band of bands) {
                const from = self.valToPos(band.from, 'x', true)
                const to = self.valToPos(band.to, 'x', true)
                context.fillStyle = band.colour
                context.fillRect(
                  Math.min(from, to),
                  self.bbox.top,
                  Math.abs(to - from),
                  self.bbox.height,
                )
              }
              context.restore()
            },
            setScale: publishGeometry,
            setSize: publishGeometry,
          },
        },
      ],
    }

    const initial: uPlot.AlignedData = [new Float64Array(0), ...model.traces.map(() => new Float64Array(0))]
    const plot = new uPlot(options, initial, root)
    plotRef.current = plot
    onCanvasChange(plot.ctx.canvas)
    publishGeometry()

    return () => {
      plot.destroy()
      plotRef.current = null
      onCanvasChange(null)
    }
  }, [
    model,
    palette,
    size.width,
    size.height,
    primaryDragReserved,
    publishGeometry,
    onCanvasChange,
    onGeometryChange,
  ])

  /**
   * Push decimated data for the current viewport.
   *
   * Decimation is redone whenever the viewport or the width changes, which is
   * what makes zooming actually reveal detail: decimating once against the full
   * range would keep a zoomed-in view at the resolution of the zoomed-out one.
   */
  useEffect(() => {
    const plot = plotRef.current
    if (plot === null || model.traces.length === 0) return

    const columns = columnsForWidth(plot.bbox.width / devicePixelRatio)
    const grid = buildDisplayGrid(viewport.min, viewport.max, columns)
    const data: uPlot.AlignedData = [
      grid.x,
      ...model.traces.map((trace) => decimateToGrid(grid, trace.time, trace.values).y),
    ]
    plot.setData(data, false)
    plot.setScale('x', { min: viewport.min, max: viewport.max })
    publishGeometry()
  }, [model, viewport, size.width, size.height, publishGeometry])

  /** Wheel zoom about the pointer, and Shift-drag (or middle-drag) to pan. */
  useEffect(() => {
    const plot = plotRef.current
    if (plot === null) return
    const over = plot.over

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewportRef.current
      const span = current.max - current.min
      const rect = over.getBoundingClientRect()
      const fraction = rect.width === 0 ? 0.5 : (event.clientX - rect.left) / rect.width
      const anchor = current.min + fraction * span
      // Zooming about the pointer rather than the centre is what makes a wheel
      // feel like a magnifier instead of a scrollbar.
      const scale = Math.exp(event.deltaY * WHEEL_ZOOM_FACTOR)
      const nextSpan = span * scale
      onViewportChangeRef.current(
        clampViewport(
          { min: anchor - fraction * nextSpan, max: anchor + (1 - fraction) * nextSpan },
          boundsRef.current,
        ),
      )
    }

    let panning: { clientX: number; start: ChartViewport } | null = null

    const onPointerDown = (event: PointerEvent) => {
      const isPanGesture = event.button === 1 || (event.button === 0 && event.shiftKey)
      if (!isPanGesture) return
      event.preventDefault()
      panning = { clientX: event.clientX, start: viewportRef.current }
      over.setPointerCapture(event.pointerId)
    }

    const onPointerMove = (event: PointerEvent) => {
      if (panning === null) return
      const rect = over.getBoundingClientRect()
      if (rect.width === 0) return
      const span = panning.start.max - panning.start.min
      const delta = ((event.clientX - panning.clientX) / rect.width) * span
      onViewportChangeRef.current(
        clampViewport(
          { min: panning.start.min - delta, max: panning.start.max - delta },
          boundsRef.current,
        ),
      )
    }

    const endPan = (event: PointerEvent) => {
      if (panning === null) return
      panning = null
      if (over.hasPointerCapture(event.pointerId)) over.releasePointerCapture(event.pointerId)
    }

    over.addEventListener('wheel', onWheel, { passive: false })
    over.addEventListener('pointerdown', onPointerDown)
    over.addEventListener('pointermove', onPointerMove)
    over.addEventListener('pointerup', endPan)
    over.addEventListener('pointercancel', endPan)

    return () => {
      over.removeEventListener('wheel', onWheel)
      over.removeEventListener('pointerdown', onPointerDown)
      over.removeEventListener('pointermove', onPointerMove)
      over.removeEventListener('pointerup', endPan)
      over.removeEventListener('pointercancel', endPan)
    }
  }, [model, palette, size.width, size.height, primaryDragReserved])

  return (
    <div className="plot-frame" ref={rootRef} aria-labelledby={titleId}>
      <p className="visually-hidden" id={titleId}>
        {model.title}
      </p>
      {model.emptyMessage !== null ? (
        <p className="plot-frame__empty">{model.emptyMessage}</p>
      ) : null}
      {props.children}
    </div>
  )
}

export { clampViewport }
