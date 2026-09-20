/**
 * Replaying a stored analysis, with the analyzer's own machinery.
 *
 * This is the component that decides whether a cloud record is a *record* or a photograph. A
 * snapshot carries every full-resolution series the analysis produced, so a reader who opens a
 * two-year-old run must be able to do to it exactly what they could do to a freshly parsed CSV:
 * look at the graph, switch views, drag out a range, read that range's statistics, export the
 * workbook, and build a formal figure of it. Every one of those is the analyzer's code path here,
 * not a second implementation:
 *
 * | capability | what does it |
 * | --- | --- |
 * | graph | `buildPlotModel` → `UPlotChart`, the same pair `AnalyzerScreen` uses |
 * | view modes | `transition` from `graph/view-mode.ts` — the desktop's state machine |
 * | range selection | `SelectionOverlay`, over `ChartGeometry` published by the chart |
 * | range statistics | `rangeStatisticsFor`, over the **filtered full-resolution** series |
 * | Excel / CSV | `exportWorkbookFor` → `ExportClient`, the same worker |
 * | custom poster | `PosterDialog` from `src/poster/`, the analyzer's own |
 *
 * There is no second renderer and no "read-only" variant of any of them. If a number here differed
 * from the number the analyzer showed the day the run was measured, the snapshot would have failed
 * at its one job.
 *
 * ## The configuration is the snapshot's, the theme is the reader's
 *
 * Two settings that look alike are treated oppositely, and the distinction is what keeps a replay
 * reproducible. `ylim_min`/`ylim_max`, `default_graph_duration` and `sampling_rate` come from the
 * snapshot: they frame the figure and set the export's resampling rate, so taking them from the
 * reader's `localStorage` would make the same stored run export differently on two desks. The
 * colour theme comes from the document, because it is the reader's eyesight and their room, and it
 * cannot change a number.
 *
 * ## What is not offered, and why
 *
 * Comparison. `ENTER_COMPARING` needs two datasets and this panel holds one; offering a control
 * that could never do anything would be worse than its absence. Comparing two stored runs is a
 * gallery-level feature and it is not built.
 */

import type { AnalysisConfig } from '@aat/shared'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Dataset, type SensorMode, sensorModeFrom } from '../app/dataset.ts'
import { rangeResultFor } from '../app/range-statistics.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import { ExportClient } from '../exporting/client.ts'
import { exportPngFor, rangeInputFor, runWorkbookExport } from '../exporting/export-actions.ts'
import { workbookInputFor } from '../exporting/input.ts'
import { PNG_PARITY_NOTICE } from '../exporting/png.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import { buildPlotModel, defaultViewportFor, graphBoundsFor, modelDataRange } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import { themeSettingFrom } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import { useThemePalette } from '../graph/use-theme-palette.ts'
import type { ViewMode } from '../graph/view-mode.ts'
import { canSelectRange, isGQuality, isShowingAll } from '../graph/view-mode.ts'
import { PosterDialog } from '../poster/PosterDialog.tsx'
import type { ReplayedAnalysis } from '../runs/replay.ts'
import { applyViewEvent } from './hooks.ts'
import { RangeStatisticsPanel } from './RangeStatisticsPanel.tsx'
import { StatisticsPanel } from './StatisticsPanel.tsx'

export interface RunReplayPanelProps {
  replay: ReplayedAnalysis
  analysisRevisionId: string
  runCode: string
  /** False for a Viewer, who holds `analysis:read` and `cloud:read` but not `poster:generate`. */
  canGeneratePoster: boolean
  onPosterRendered: (poster: PosterFigure) => void
  onNotice: (tone: 'info' | 'warning' | 'error', text: string) => void
}

/** The reader's theme, from the attribute `index.html` writes before first paint. */
function documentThemeSetting(): string {
  if (typeof document === 'undefined') return 'system'
  return document.documentElement.dataset.theme ?? 'system'
}

/**
 * The export worker client. Lazily constructed, so merely opening a snapshot
 * does not start a worker.
 */
function useExportClient(): () => ExportClient {
  const exportClient = useRef<ExportClient | null>(null)
  const getExportClient = useCallback(() => {
    exportClient.current ??= new ExportClient()
    return exportClient.current
  }, [])
  useEffect(
    () => () => {
      exportClient.current?.dispose()
      exportClient.current = null
    },
    [],
  )
  return getExportClient
}

interface ReplayExportDeps {
  dataset: Dataset
  rangeResult: ReturnType<typeof rangeResultFor>
  getExportClient: () => ExportClient
  onNotice: (tone: 'info' | 'warning' | 'error', text: string) => void
  setExporting: Dispatch<SetStateAction<boolean>>
}

async function exportReplayFor(deps: ReplayExportDeps, format: 'xlsx' | 'csv'): Promise<void> {
  deps.setExporting(true)
  try {
    // The snapshot's sampling rate, not the reader's: this is the rate the
    // unified export axis was resampled onto when the analysis was performed.
    const input = workbookInputFor(
      deps.dataset,
      deps.dataset.config.sampling_rate,
      rangeInputFor(deps.rangeResult),
    )
    await runWorkbookExport({
      input,
      name: deps.dataset.name,
      format,
      getExportClient: deps.getExportClient,
      notify: deps.onNotice,
    })
  } catch (error) {
    deps.onNotice('error', error instanceof Error ? error.message : String(error))
  } finally {
    deps.setExporting(false)
  }
}

/** The normal / show-all / G-quality segmented control. */
function ReplayModeButtons({
  mode,
  gQualityComputed,
  applyEvent,
}: {
  mode: ViewMode
  gQualityComputed: boolean
  applyEvent: (event: Parameters<typeof applyViewEvent>[1]) => void
}): React.JSX.Element {
  const showingAll = isShowingAll(mode)
  const showingGQuality = isGQuality(mode)
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">表示モード</legend>
      <button
        type="button"
        className="button"
        aria-pressed={!showingAll && !showingGQuality}
        onClick={() => applyEvent(showingAll ? 'SHOW_ALL_OFF' : 'G_QUALITY_OFF')}
      >
        通常
      </button>
      <button
        type="button"
        className="button"
        aria-pressed={showingAll}
        onClick={() => applyEvent(showingAll ? 'SHOW_ALL_OFF' : 'SHOW_ALL_ON')}
      >
        全データ
      </button>
      <button
        type="button"
        className="button"
        aria-pressed={showingGQuality}
        disabled={!gQualityComputed}
        title={gQualityComputed ? undefined : 'このリビジョンにG-qualityの計算結果がありません'}
        onClick={() => applyEvent(showingGQuality ? 'G_QUALITY_OFF' : 'G_QUALITY_ON')}
      >
        G-quality
      </button>
    </fieldset>
  )
}

/** The replay toolbar: view modes, sensor, reset, the two exports, the poster door. */
function ReplayToolbar({
  mode,
  gQualityComputed,
  sensorMode,
  canvasReady,
  exporting,
  canGeneratePoster,
  applyEvent,
  onSensorMode,
  onResetViewport,
  onExport,
  onExportPng,
  onOpenPoster,
}: {
  mode: ViewMode
  gQualityComputed: boolean
  sensorMode: SensorMode
  canvasReady: boolean
  exporting: boolean
  canGeneratePoster: boolean
  applyEvent: (event: Parameters<typeof applyViewEvent>[1]) => void
  onSensorMode: (mode: SensorMode) => void
  onResetViewport: () => void
  onExport: (format: 'xlsx' | 'csv') => void
  onExportPng: () => void
  onOpenPoster: () => void
}): React.JSX.Element {
  return (
    <div className="run-replay__toolbar">
      <ReplayModeButtons mode={mode} gQualityComputed={gQualityComputed} applyEvent={applyEvent} />

      <label className="field">
        <span className="visually-hidden">表示するセンサー</span>
        <select
          className="select"
          value={sensorMode}
          onChange={(event) => onSensorMode(sensorModeFrom(event.target.value))}
        >
          <option value="both">両方</option>
          <option value="inner_only">Inner Capsule のみ</option>
          <option value="drag_only">Drag Shield のみ</option>
        </select>
      </label>

      <button type="button" className="button" onClick={onResetViewport}>
        全体表示
      </button>
      <button type="button" className="button" disabled={exporting} onClick={() => onExport('xlsx')}>
        Excelで書き出す
      </button>
      <button type="button" className="button" disabled={exporting} onClick={() => onExport('csv')}>
        CSVで書き出す
      </button>
      <button
        type="button"
        className="button"
        disabled={!canvasReady}
        title={PNG_PARITY_NOTICE}
        onClick={onExportPng}
      >
        PNGを保存
      </button>
      <button
        type="button"
        className="button"
        disabled={!canGeneratePoster}
        title={canGeneratePoster ? undefined : 'ポスターを生成する権限がありません'}
        onClick={onOpenPoster}
      >
        ポスター図を作成
      </button>
    </div>
  )
}

export function RunReplayPanel(props: RunReplayPanelProps): React.JSX.Element {
  const { replay, analysisRevisionId, runCode, onNotice } = props
  const dataset = replay.dataset
  const config: AnalysisConfig = replay.config

  const [mode, setMode] = useState<ViewMode>('NORMAL')
  const [sensorMode, setSensorMode] = useState<SensorMode>(() => sensorModeFrom(config.graph_sensor_mode))
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const [viewport, setViewport] = useState<ChartViewport | null>(null)
  const [geometry, setGeometry] = useState<ChartGeometry | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [gestureLayer, setGestureLayer] = useState<HTMLElement | null>(null)
  const [posterOpen, setPosterOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const getExportClient = useExportClient()
  const { palette } = useThemePalette(themeSettingFrom(documentThemeSetting()))

  const plotModel = useMemo(
    () =>
      buildPlotModel({
        datasets: [dataset],
        active: dataset,
        mode,
        sensorMode,
        palette,
        ylimMin: config.ylim_min,
        ylimMax: config.ylim_max,
        defaultGraphDuration: config.default_graph_duration,
      }),
    [dataset, mode, sensorMode, palette, config],
  )

  const dataRange = useMemo(() => modelDataRange(plotModel), [plotModel])
  const defaultViewport = useMemo(
    (): ChartViewport => defaultViewportFor(plotModel, dataRange, config.default_graph_duration),
    [plotModel, dataRange, config.default_graph_duration],
  )
  const bounds = useMemo(
    (): ChartViewport => graphBoundsFor(dataRange, defaultViewport),
    [dataRange, defaultViewport],
  )
  const effectiveViewport = viewport ?? defaultViewport

  const selectionEnabled = canSelectRange(mode)
  const rangeResult = useMemo(
    () => rangeResultFor(dataset, selection, selectionEnabled),
    [dataset, selection, selectionEnabled],
  )

  const applyEvent = (event: Parameters<typeof applyViewEvent>[1]) =>
    applyViewEvent(mode, event, { setMode, setSelection, setViewport })

  const doExport = (format: 'xlsx' | 'csv') =>
    exportReplayFor({ dataset, rangeResult, getExportClient, onNotice, setExporting }, format)
  const doPngExport = () => exportPngFor({ canvas, dataset, palette, notify: onNotice })

  return (
    <div className="run-replay">
      <ReplayToolbar
        mode={mode}
        gQualityComputed={dataset.gQualityComputed}
        sensorMode={sensorMode}
        canvasReady={canvas !== null}
        exporting={exporting}
        canGeneratePoster={props.canGeneratePoster}
        applyEvent={applyEvent}
        onSensorMode={setSensorMode}
        onResetViewport={() => setViewport(null)}
        onExport={(format) => void doExport(format)}
        onExportPng={() => void doPngExport()}
        onOpenPoster={() => setPosterOpen(true)}
      />

      <p className="panel__hint">
        ホイールで拡大縮小、Shift+ドラッグで移動します。通常表示ではドラッグで範囲を選択できます。
      </p>

      <div className="run-replay__plot">
        <UPlotChart
          model={plotModel}
          palette={palette}
          viewport={effectiveViewport}
          onViewportChange={setViewport}
          bounds={bounds}
          onGeometryChange={setGeometry}
          onCanvasChange={setCanvas}
          onGestureLayerChange={setGestureLayer}
          primaryDragReserved={selectionEnabled}
        >
          <SelectionOverlay
            geometry={geometry}
            selection={selection}
            onSelectionChange={setSelection}
            enabled={selectionEnabled}
            gestureLayer={gestureLayer}
          />
        </UPlotChart>
      </div>

      <StatisticsPanel datasets={[dataset]} mode={mode} />

      <RangeStatisticsPanel
        selection={selection}
        result={rangeResult}
        enabled={selectionEnabled}
        onChange={setSelection}
      />

      {/* The analyzer's own custom-poster dialog, not a second one. It already builds the spec from
          the dataset's branded full-resolution arrays, offers only the bounded choices the frozen
          preset defines, previews the real title line, and turns a builder refusal into advice with
          a remedy — writing a gallery-flavoured copy of that would be two dialogs that have to be
          kept in step, and one of them would eventually not be. */}
      {posterOpen ? (
        <PosterDialog
          context={{ revisionId: analysisRevisionId, runCode, dataset }}
          selection={selection}
          yRange={{ min: config.ylim_min, max: config.ylim_max }}
          onClose={() => setPosterOpen(false)}
          onCreated={(poster) => props.onPosterRendered(poster)}
        />
      ) : null}
    </div>
  )
}
