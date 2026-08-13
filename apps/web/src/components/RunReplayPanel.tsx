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
 * | Excel / CSV | `workbookInputFor` → `ExportClient`, the same worker |
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type SensorMode, sensorModeFrom } from '../app/dataset.ts'
import { rangeStatisticsFor } from '../app/range-statistics.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import { ExportClient, ExportTooLargeForWorksheet, saveBlob } from '../exporting/client.ts'
import { workbookInputFor } from '../exporting/input.ts'
import { canvasToPng, PNG_PARITY_NOTICE } from '../exporting/png.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import { buildPlotModel, modelDataRange } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import { graphPalette, prefersDarkScheme, resolveTheme, themeSettingFrom } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import type { ViewMode } from '../graph/view-mode.ts'
import { canSelectRange, isGQuality, isShowingAll, transition } from '../graph/view-mode.ts'
import { PosterDialog } from '../poster/PosterDialog.tsx'
import type { ReplayedAnalysis } from '../runs/replay.ts'
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
  const [posterOpen, setPosterOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const exportClient = useRef<ExportClient | null>(null)
  const getExportClient = useCallback(() => {
    // Lazily constructed, so merely opening a snapshot does not start an export worker.
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

  const [systemDark, setSystemDark] = useState(prefersDarkScheme)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  const palette = useMemo(
    () => graphPalette(resolveTheme(themeSettingFrom(documentThemeSetting()), systemDark)),
    [systemDark],
  )

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
  const defaultViewport = useMemo((): ChartViewport => {
    if (plotModel.xRange !== null) return { min: plotModel.xRange[0], max: plotModel.xRange[1] }
    if (dataRange !== null && dataRange.max > dataRange.min) return { min: dataRange.min, max: dataRange.max }
    return { min: 0, max: config.default_graph_duration }
  }, [plotModel, dataRange, config.default_graph_duration])
  const bounds = useMemo((): ChartViewport => {
    if (dataRange === null) return defaultViewport
    return {
      min: Math.min(dataRange.min, defaultViewport.min),
      max: Math.max(dataRange.max, defaultViewport.max),
    }
  }, [dataRange, defaultViewport])
  const effectiveViewport = viewport ?? defaultViewport

  const selectionEnabled = canSelectRange(mode)
  const rangeResult = useMemo(() => {
    if (selection === null || !selectionEnabled) return null
    return rangeStatisticsFor(dataset, selection)
  }, [dataset, selection, selectionEnabled])

  const applyEvent = (event: Parameters<typeof transition>[1]) => {
    setMode((current) => {
      const next = transition(current, event)
      // Leaving the normal view invalidates a selection: the other views have no single time axis,
      // so the span would no longer mean the thing it was drawn over.
      if (!canSelectRange(next)) setSelection(null)
      return next
    })
    setViewport(null)
  }

  const doExport = async (format: 'xlsx' | 'csv') => {
    setExporting(true)
    try {
      const input = workbookInputFor(
        dataset,
        // The snapshot's sampling rate, not the reader's: this is the rate the unified export axis
        // was resampled onto when the analysis was performed.
        config.sampling_rate,
        rangeResult === null
          ? null
          : { range: rangeResult.range, inner: rangeResult.inner, drag: rangeResult.drag },
      )
      const result = await getExportClient().run(format, input)
      saveBlob(result.blob, `${dataset.name}.${format}`)
      onNotice('info', `${dataset.name} を書き出しました。`)
    } catch (error) {
      if (error instanceof ExportTooLargeForWorksheet) {
        // Never truncate a worksheet. Say how big it is and offer the format with no row limit.
        onNotice('warning', `${error.message}\n「CSVで書き出す」を選ぶと、行数制限なしで保存できます。`)
        return
      }
      onNotice('error', error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  const doPngExport = async () => {
    if (canvas === null) {
      onNotice('warning', 'グラフが表示されていないため、PNGを保存できません。')
      return
    }
    try {
      const blob = await canvasToPng(canvas, { scale: 2, background: palette.background })
      saveBlob(blob, `${dataset.name}_gl.png`)
      onNotice('info', PNG_PARITY_NOTICE)
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="run-replay">
      <div className="run-replay__toolbar">
        <fieldset className="segmented">
          <legend className="visually-hidden">表示モード</legend>
          <button
            type="button"
            className="button"
            aria-pressed={!isShowingAll(mode) && !isGQuality(mode)}
            onClick={() => applyEvent(isShowingAll(mode) ? 'SHOW_ALL_OFF' : 'G_QUALITY_OFF')}
          >
            通常
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={isShowingAll(mode)}
            onClick={() => applyEvent(isShowingAll(mode) ? 'SHOW_ALL_OFF' : 'SHOW_ALL_ON')}
          >
            全データ
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={isGQuality(mode)}
            disabled={!dataset.gQualityComputed}
            title={dataset.gQualityComputed ? undefined : 'このリビジョンにG-qualityの計算結果がありません'}
            onClick={() => applyEvent(isGQuality(mode) ? 'G_QUALITY_OFF' : 'G_QUALITY_ON')}
          >
            G-quality
          </button>
        </fieldset>

        <label className="field">
          <span className="visually-hidden">表示するセンサー</span>
          <select
            className="select"
            value={sensorMode}
            onChange={(event) => setSensorMode(sensorModeFrom(event.target.value))}
          >
            <option value="both">両方</option>
            <option value="inner_only">Inner Capsule のみ</option>
            <option value="drag_only">Drag Shield のみ</option>
          </select>
        </label>

        <button type="button" className="button" onClick={() => setViewport(null)}>
          全体表示
        </button>
        <button type="button" className="button" disabled={exporting} onClick={() => void doExport('xlsx')}>
          Excelで書き出す
        </button>
        <button type="button" className="button" disabled={exporting} onClick={() => void doExport('csv')}>
          CSVで書き出す
        </button>
        <button
          type="button"
          className="button"
          disabled={canvas === null}
          title={PNG_PARITY_NOTICE}
          onClick={() => void doPngExport()}
        >
          PNGを保存
        </button>
        <button
          type="button"
          className="button"
          disabled={!props.canGeneratePoster}
          title={props.canGeneratePoster ? undefined : 'ポスターを生成する権限がありません'}
          onClick={() => setPosterOpen(true)}
        >
          ポスター図を作成
        </button>
      </div>

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
          primaryDragReserved={selectionEnabled}
        >
          <SelectionOverlay
            geometry={geometry}
            selection={selection}
            onSelectionChange={setSelection}
            enabled={selectionEnabled}
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
          onClose={() => setPosterOpen(false)}
          onCreated={(poster) => props.onPosterRendered(poster)}
        />
      ) : null}
    </div>
  )
}
