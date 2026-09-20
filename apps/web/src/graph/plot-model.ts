/**
 * What to draw, decided before anything is drawn.
 *
 * `plot_controller.py` mixes three concerns — choosing series, styling axes, and
 * calling Matplotlib — inside one 200-line method per view. Separating the
 * choice out means the interesting part (which series, which axis, which range,
 * for which mode) is a pure function that can be reasoned about and tested,
 * while the uPlot component stays a thin renderer.
 *
 * Every series here is full resolution. Decimation happens in the renderer,
 * against the viewport it is actually drawing into.
 */

import { asFullResolution, type FullResolutionArray } from '../analysis/series.ts'
import type { Dataset, SensorMode } from '../app/dataset.ts'
import { hasAllData, hasFilteredData, resolveSensorVisibility } from '../app/dataset.ts'
import { comparisonColour, type GraphPalette } from './theme.ts'
import { isComparing, isGQuality, isShowingAll, usesFixedDuration, type ViewMode } from './view-mode.ts'

export interface PlotTrace {
  key: string
  label: string
  colour: string
  time: FullResolutionArray
  values: FullResolutionArray
  /** Right-hand axis, used only by the G-quality standard-deviation traces. */
  axis: 'y' | 'y2'
}

/** A shaded x span, used by show-all to mark what filtering kept. */
export interface PlotBand {
  from: number
  to: number
  colour: string
  label: string
}

export interface PlotModel {
  traces: PlotTrace[]
  title: string
  xLabel: string
  yLabel: string
  /** Null when there is no right-hand axis. */
  y2Label: string | null
  /** Null means "fit to the data", which is what show-all needs. */
  xRange: readonly [number, number] | null
  yRange: readonly [number, number] | null
  bands: PlotBand[]
  /** Set when there is nothing to draw; the renderer shows it instead of a plot. */
  emptyMessage: string | null
}

export interface PlotInputs {
  datasets: readonly Dataset[]
  active: Dataset | null
  mode: ViewMode
  sensorMode: SensorMode
  palette: GraphPalette
  ylimMin: number
  ylimMax: number
  defaultGraphDuration: number
}

const EMPTY_MODEL_BASE = {
  traces: [] as PlotTrace[],
  xLabel: 'Time (s)',
  yLabel: 'Gravity Level (G)',
  y2Label: null,
  xRange: null,
  yRange: null,
  bands: [] as PlotBand[],
} satisfies Omit<PlotModel, 'title' | 'emptyMessage'>

/** Pull one G-quality column into a pair of arrays, dropping rows without a value. */
function gQualitySeries(
  dataset: Dataset,
  pick: (row: Dataset['gQuality'][number]) => number | null,
): { x: FullResolutionArray; y: FullResolutionArray } {
  const xs: number[] = []
  const ys: number[] = []
  for (const row of dataset.gQuality) {
    const value = pick(row)
    if (value === null) continue
    xs.push(row.windowSize)
    ys.push(value)
  }
  return { x: asFullResolution(Float64Array.from(xs)), y: asFullResolution(Float64Array.from(ys)) }
}

function gQualityModel(inputs: PlotInputs): PlotModel {
  const { active, palette } = inputs
  if (active === null) {
    return { ...EMPTY_MODEL_BASE, title: 'G-quality Analysis', emptyMessage: 'データセットがありません。' }
  }

  if (active.gQuality.length === 0) {
    return {
      ...EMPTY_MODEL_BASE,
      title: `G-quality Analysis: ${active.name}`,
      emptyMessage: 'G-qualityデータが不十分です。\nデータ長を確認してください。',
    }
  }

  const traces: PlotTrace[] = []
  const definitions = [
    {
      key: 'inner-mean',
      label: 'Inner Capsule: Mean Gravity Level',
      colour: palette.innerMean,
      axis: 'y' as const,
      pick: (row: Dataset['gQuality'][number]) => row.innerMean,
    },
    {
      key: 'drag-mean',
      label: 'Drag Shield: Mean Gravity Level',
      colour: palette.dragMean,
      axis: 'y' as const,
      pick: (row: Dataset['gQuality'][number]) => row.dragMean,
    },
    {
      key: 'inner-std',
      label: 'Inner Capsule: Standard Deviation',
      colour: palette.innerStd,
      axis: 'y2' as const,
      pick: (row: Dataset['gQuality'][number]) => row.innerStd,
    },
    {
      key: 'drag-std',
      label: 'Drag Shield: Standard Deviation',
      colour: palette.dragStd,
      axis: 'y2' as const,
      pick: (row: Dataset['gQuality'][number]) => row.dragStd,
    },
  ]

  for (const definition of definitions) {
    const series = gQualitySeries(active, definition.pick)
    if (series.x.length === 0) continue
    traces.push({
      key: definition.key,
      label: definition.label,
      colour: definition.colour,
      time: series.x,
      values: series.y,
      axis: definition.axis,
    })
  }

  return {
    traces,
    title: `G-quality Analysis - ${active.name}`,
    xLabel: 'Window Size (s)',
    yLabel: 'Mean Gravity Level (G)',
    // Twin axes: mean on the left, standard deviation on the right. They differ
    // by orders of magnitude, and sharing one axis flattens the standard
    // deviation curve into the zero line.
    y2Label: 'Standard Deviation (G)',
    xRange: null,
    yRange: null,
    bands: [],
    emptyMessage: traces.length === 0 ? 'G-qualityデータが不十分です。' : null,
  }
}

/** What a trace needs besides its arrays: identity and a colour chosen only when drawn. */
interface SensorTraceSpec {
  key: string
  label: string
  colour: () => string
}

interface SensorTraceSpecs {
  inner: SensorTraceSpec
  drag: SensorTraceSpec
}

/** Which arrays a sensor contributes: raw under show-all, filtered otherwise. */
function sensorView(
  sensor: Dataset['inner'] | Dataset['drag'],
  showingAll: boolean,
): {
  time: FullResolutionArray
  values: FullResolutionArray
} {
  return showingAll
    ? { time: sensor.time, values: sensor.gravity }
    : { time: sensor.filteredTime, values: sensor.filteredGravity }
}

/** Inner/drag visibility for one dataset: all data under show-all, filtered otherwise. */
function visibleSensors(
  dataset: Dataset,
  showingAll: boolean,
  sensorMode: SensorMode,
): ReturnType<typeof resolveSensorVisibility> {
  return resolveSensorVisibility(
    sensorMode,
    showingAll ? hasAllData(dataset.inner) : hasFilteredData(dataset.inner),
    showingAll ? hasAllData(dataset.drag) : hasFilteredData(dataset.drag),
  )
}

/**
 * The inner/drag pair one dataset contributes. `colour` is a thunk because the
 * comparison palette hands colours out in push order — a sensor that stays
 * hidden must not consume one.
 */
function sensorTraces(
  dataset: Dataset,
  showingAll: boolean,
  sensorMode: SensorMode,
  specs: SensorTraceSpecs,
): PlotTrace[] {
  const { showInner, showDrag } = visibleSensors(dataset, showingAll, sensorMode)
  const traces: PlotTrace[] = []
  if (showInner) {
    traces.push({
      key: specs.inner.key,
      label: specs.inner.label,
      colour: specs.inner.colour(),
      ...sensorView(dataset.inner, showingAll),
      axis: 'y',
    })
  }
  if (showDrag) {
    traces.push({
      key: specs.drag.key,
      label: specs.drag.label,
      colour: specs.drag.colour(),
      ...sensorView(dataset.drag, showingAll),
      axis: 'y',
    })
  }
  return traces
}

/**
 * One mean trace per sensor per dataset. The desktop compares means only: a
 * second axis shared by many datasets would need one scale for every
 * standard-deviation curve, and the plot stops being readable long before
 * that is useful.
 */
function gQualityComparisonTraces(datasets: readonly Dataset[], palette: GraphPalette): PlotTrace[] {
  const traces: PlotTrace[] = []
  let colourIndex = 0
  for (const dataset of datasets) {
    for (const [label, pick] of [
      ['Inner Capsule', (row: Dataset['gQuality'][number]) => row.innerMean],
      ['Drag Shield', (row: Dataset['gQuality'][number]) => row.dragMean],
    ] as const) {
      const series = gQualitySeries(dataset, pick)
      if (series.x.length === 0) continue
      traces.push({
        key: `${dataset.name}:${label}`,
        label: `${dataset.name} (${label})`,
        colour: comparisonColour(palette, colourIndex++),
        time: series.x,
        values: series.y,
        axis: 'y',
      })
    }
  }
  return traces
}

function sensorComparisonTraces(inputs: PlotInputs): PlotTrace[] {
  const { datasets, mode, sensorMode, palette } = inputs
  const showingAll = isShowingAll(mode)
  const traces: PlotTrace[] = []
  let colourIndex = 0
  for (const dataset of datasets) {
    traces.push(
      ...sensorTraces(dataset, showingAll, sensorMode, {
        inner: {
          key: `${dataset.name}:inner`,
          label: `${dataset.name} (Inner Capsule)`,
          colour: () => comparisonColour(palette, colourIndex++),
        },
        drag: {
          key: `${dataset.name}:drag`,
          label: `${dataset.name} (Drag Shield)`,
          colour: () => comparisonColour(palette, colourIndex++),
        },
      }),
    )
  }
  return traces
}

function gQualityComparisonModel(inputs: PlotInputs): PlotModel {
  const traces = gQualityComparisonTraces(inputs.datasets, inputs.palette)
  return {
    traces,
    title: 'G-quality Analysis Comparison',
    xLabel: 'Window Size (s)',
    yLabel: 'Mean Gravity Level (G)',
    y2Label: null,
    xRange: null,
    yRange: null,
    bands: [],
    emptyMessage: traces.length === 0 ? '比較できるデータがありません。' : null,
  }
}

function sensorComparisonModel(inputs: PlotInputs): PlotModel {
  const traces = sensorComparisonTraces(inputs)
  return {
    traces,
    title: 'Gravity Level Comparison',
    xLabel: 'Time (s)',
    yLabel: 'Gravity Level (G)',
    y2Label: null,
    // The comparison keeps the fixed window so several runs stay comparable;
    // show-all must not be clipped, because revealing what filtering removed is
    // the entire point of it.
    xRange: usesFixedDuration(inputs.mode) ? [0, inputs.defaultGraphDuration] : null,
    yRange: isShowingAll(inputs.mode) ? null : [inputs.ylimMin, inputs.ylimMax],
    bands: [],
    emptyMessage: traces.length === 0 ? '比較できるデータがありません。' : null,
  }
}

function comparisonModel(inputs: PlotInputs): PlotModel {
  return isGQuality(inputs.mode) ? gQualityComparisonModel(inputs) : sensorComparisonModel(inputs)
}

/** Show-all marks what filtering kept, so the trimmed segment can be seen in context. */
function keptRangeBands(
  active: Dataset,
  showInner: boolean,
  showDrag: boolean,
  palette: GraphPalette,
): PlotBand[] {
  const kept = [
    { show: showInner, sensor: active.inner, colour: palette.innerMean, label: 'Inner Capsule Range' },
    { show: showDrag, sensor: active.drag, colour: palette.dragMean, label: 'Drag Shield Range' },
  ]
  const bands: PlotBand[] = []
  for (const { show, sensor, colour, label } of kept) {
    const end = sensor.filteredTime.at(-1)
    if (show && end !== undefined) bands.push({ from: 0, to: end, colour, label })
  }
  return bands
}

/**
 * The single-dataset trace specs. Show-all drops the dataset name from the
 * legend — with only one dataset on screen, the name is the title's job.
 */
function singleSensorSpecs(active: Dataset, showingAll: boolean, palette: GraphPalette): SensorTraceSpecs {
  return {
    inner: {
      key: 'inner',
      label: showingAll ? 'Inner Capsule' : `${active.name} (Inner Capsule)`,
      colour: () => palette.innerMean,
    },
    drag: {
      key: 'drag',
      label: showingAll ? 'Drag Shield' : `${active.name} (Drag Shield)`,
      colour: () => palette.dragMean,
    },
  }
}

function singleDatasetModel(inputs: PlotInputs): PlotModel {
  const { active, mode, sensorMode, palette } = inputs
  if (active === null) {
    return { ...EMPTY_MODEL_BASE, title: 'The Gravity Level', emptyMessage: 'CSVファイルを開いてください。' }
  }

  const showingAll = isShowingAll(mode)
  const { showInner, showDrag } = visibleSensors(active, showingAll, sensorMode)
  const traces = sensorTraces(active, showingAll, sensorMode, singleSensorSpecs(active, showingAll, palette))

  // Show-all keeps the data's own extent and marks the kept range; the filtered
  // modes pin the fixed window and the configured y limits.
  const framing = showingAll
    ? { suffix: ' (All Data)', xRange: null, yRange: null }
    : {
        suffix: '',
        xRange: [0, inputs.defaultGraphDuration] as const,
        yRange: [inputs.ylimMin, inputs.ylimMax] as const,
      }
  return {
    traces,
    title: `The Gravity Level ${active.name}${framing.suffix}`,
    xLabel: 'Time (s)',
    yLabel: 'Gravity Level (G)',
    y2Label: null,
    xRange: framing.xRange,
    yRange: framing.yRange,
    bands: showingAll ? keptRangeBands(active, showInner, showDrag, palette) : [],
    emptyMessage: traces.length === 0 ? '表示できる加速度データがありません。' : null,
  }
}

/** Decide what the current mode should draw. */
export function buildPlotModel(inputs: PlotInputs): PlotModel {
  if (isComparing(inputs.mode)) return comparisonModel(inputs)
  if (isGQuality(inputs.mode)) return gQualityModel(inputs)
  return singleDatasetModel(inputs)
}

/** The x extent of everything in the model; used by "fit to data" and reset. */
export function modelDataRange(model: PlotModel): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const trace of model.traces) {
    for (let index = 0; index < trace.time.length; index++) {
      const value = trace.time[index] as number
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return { min, max }
}

/**
 * The viewport a mode frames before the user pans or zooms: the fixed window
 * when the model pins one, else the data's own extent, else a nominal duration
 * so an empty graph still opens somewhere meaningful.
 */
export function defaultViewportFor(
  model: PlotModel,
  dataRange: { min: number; max: number } | null,
  defaultDuration: number,
): { min: number; max: number } {
  if (model.xRange !== null) return { min: model.xRange[0], max: model.xRange[1] }
  if (dataRange !== null && dataRange.max > dataRange.min) return { min: dataRange.min, max: dataRange.max }
  return { min: 0, max: defaultDuration }
}

/**
 * How far zooming out may go: the data plus whatever fixed window the mode
 * pins, so a reset always lands somewhere meaningful.
 */
export function graphBoundsFor(
  dataRange: { min: number; max: number } | null,
  defaultViewport: { min: number; max: number },
): { min: number; max: number } {
  if (dataRange === null) return defaultViewport
  return {
    min: Math.min(dataRange.min, defaultViewport.min),
    max: Math.max(dataRange.max, defaultViewport.max),
  }
}
