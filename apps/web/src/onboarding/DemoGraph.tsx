/**
 * The demo's graph area — the real chart, not a drawing of one.
 *
 * `UPlotChart`, `SelectionOverlay` and `buildPlotModel` are the application's
 * own; what the demo supplies is the same `PlotInputs` the analyzer would
 * compute, driven by the timeline instead of by user state. The line "drawing
 * itself in" is the viewport animating open — which also means it is real
 * uPlot scale-setting, the same path wheel-zoom uses.
 *
 * Everything is inert: `primaryDragReserved` mirrors the real mode but the
 * stage overlay swallows pointer events before they reach the chart, so the
 * script can never be interrupted mid-gesture.
 *
 * Callback identity matters here: `UPlotChart` rebuilds the plot when its
 * callback props change identity, so every callback this file hands it is a
 * stable reference — module-level no-ops or `useCallback`s over stable props.
 */

import { useCallback, useMemo, useState } from 'react'
import type { Dataset } from '../app/dataset.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import { buildPlotModel, defaultViewportFor, graphBoundsFor, modelDataRange } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { GraphPalette } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import { canSelectRange } from '../graph/view-mode.ts'
import type { DemoFrame } from './demo-timeline.ts'

const noopCanvas = (_canvas: HTMLCanvasElement | null): void => {}
const noopViewport = (_viewport: ChartViewport): void => {}
const noopSelection = (_range: SelectionRange | null): void => {}

export interface DemoGraphProps {
  readonly frame: DemoFrame
  readonly datasets: readonly Dataset[]
  readonly palette: GraphPalette
  /** Stable — publishes the uPlot event layer as the 'plot' cursor anchor. */
  readonly onGestureLayer: (layer: HTMLElement | null) => void
}

export function DemoGraph(props: DemoGraphProps): React.JSX.Element {
  const { frame, datasets, palette, onGestureLayer } = props
  const [geometry, setGeometry] = useState<ChartGeometry | null>(null)
  const [gestureLayer, setGestureLayer] = useState<HTMLElement | null>(null)

  const visibleDatasets = useMemo(() => datasets.slice(0, frame.datasetCount), [datasets, frame.datasetCount])
  const model = useMemo(
    () =>
      buildPlotModel({
        datasets: visibleDatasets,
        active: visibleDatasets[0] ?? null,
        mode: frame.mode,
        sensorMode: 'both',
        palette,
        ylimMin: -1,
        ylimMax: 1,
        defaultGraphDuration: 1.45,
      }),
    [visibleDatasets, frame.mode, palette],
  )
  const { bounds, modelViewport } = useMemo(() => {
    const range = modelDataRange(model)
    const viewport = defaultViewportFor(model, range, 1.45)
    return { bounds: graphBoundsFor(range, viewport), modelViewport: viewport }
  }, [model])

  // The analyzer snaps the viewport to the model's own data range on a mode
  // change, and the demo needs that too: a viewport wider than a trace's x
  // span leaves NaN grid columns in front of the data, which uPlot counts as
  // non-nullish and its auto y-range resolves to NaN — nothing draws.
  const viewport = frame.mode === 'NORMAL' ? frame.viewport : modelViewport

  const handleGestureLayer = useCallback(
    (layer: HTMLElement | null) => {
      setGestureLayer(layer)
      onGestureLayer(layer)
    },
    [onGestureLayer],
  )
  const handleGeometry = useCallback((next: ChartGeometry | null) => setGeometry(next), [])

  return (
    <UPlotChart
      model={model}
      palette={palette}
      viewport={viewport}
      onViewportChange={noopViewport}
      bounds={bounds}
      onGeometryChange={handleGeometry}
      onCanvasChange={noopCanvas}
      onGestureLayerChange={handleGestureLayer}
      primaryDragReserved={canSelectRange(frame.mode)}
    >
      <SelectionOverlay
        geometry={geometry}
        selection={frame.selection}
        onSelectionChange={noopSelection}
        enabled={false}
        gestureLayer={gestureLayer}
      />
    </UPlotChart>
  )
}
