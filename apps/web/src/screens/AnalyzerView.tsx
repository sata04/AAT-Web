import type { AnalysisConfig } from '@aat/shared'
import type { Dispatch, SetStateAction } from 'react'
import type { ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import type { Dataset } from '../app/dataset.ts'
import { sensorModeFrom } from '../app/dataset.ts'
import type { RangeStatisticsResult } from '../app/range-statistics.ts'
import { saveConfig } from '../app/settings.ts'
import { clearCache } from '../cache/analysis-cache.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import type { CloudStatuses } from '../cloud/status.ts'
import { CloudStatusBar } from '../components/CloudStatusBar.tsx'
import { ColumnSelectorDialog } from '../components/ColumnSelectorDialog.tsx'
import { CommandBar } from '../components/CommandBar.tsx'
import { FileDropZone } from '../components/FileDropZone.tsx'
import { type NoticeItem, NoticeStack } from '../components/NoticeStack.tsx'
import { RangeStatisticsPanel } from '../components/RangeStatisticsPanel.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import { StatisticsPanel } from '../components/StatisticsPanel.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { PNG_PARITY_NOTICE } from '../exporting/png.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import type { PlotModel } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { GraphPalette } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import { isComparing, isGQuality, isShowingAll, type ViewMode } from '../graph/view-mode.ts'
import { PosterPanel } from '../poster/PosterPanel.tsx'
import type { PosterContext } from '../poster/requests.ts'

export interface PendingColumnChoice {
  source: OpenedSource
  initial: ColumnMapping
  reason: string | undefined
}

interface AnalyzerViewState {
  config: AnalysisConfig
  datasets: readonly Dataset[]
  active: Dataset | null
  activeName: string | null
  mode: ViewMode
  selection: SelectionRange | null
  rangeResult: RangeStatisticsResult | null
  selectionEnabled: boolean
  statuses: CloudStatuses
  notices: readonly NoticeItem[]
  posterContext: PosterContext | null
  posterUnavailableReason: string | null
  activeCustomPosters: readonly PosterFigure[]
  pendingColumns: PendingColumnChoice | null
  settingsOpen: boolean
}

interface AnalyzerPlotState {
  model: PlotModel
  palette: GraphPalette
  viewport: ChartViewport
  bounds: ChartViewport
  geometry: ChartGeometry | null
  canvas: HTMLCanvasElement | null
}

interface AnalyzerViewActions {
  openFiles: (files: File[]) => Promise<void>
  applyModeEvent: (
    event: 'SHOW_ALL_ON' | 'SHOW_ALL_OFF' | 'G_QUALITY_ON' | 'G_QUALITY_OFF' | 'LEAVE_COMPARING',
  ) => void
  startComparison: () => void
  setConfig: Dispatch<SetStateAction<AnalysisConfig>>
  setViewport: Dispatch<SetStateAction<ChartViewport | null>>
  setGeometry: Dispatch<SetStateAction<ChartGeometry | null>>
  setCanvas: Dispatch<SetStateAction<HTMLCanvasElement | null>>
  setSelection: Dispatch<SetStateAction<SelectionRange | null>>
  setActiveName: Dispatch<SetStateAction<string | null>>
  closeDataset: (dataset: Dataset) => void
  exportData: (format: 'xlsx' | 'csv') => Promise<void>
  exportPng: () => Promise<void>
  dismissNotice: (id: number) => void
  retrySync: () => void
  retryPoster: () => void
  addCustomPoster: (poster: PosterFigure) => void
  notify: (tone: NoticeItem['tone'], text: string) => void
  setPendingColumns: Dispatch<SetStateAction<PendingColumnChoice | null>>
  runAnalysis: (source: OpenedSource, mapping: ColumnMapping) => Promise<void>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
}

export interface AnalyzerViewProps {
  state: AnalyzerViewState
  plot: AnalyzerPlotState
  actions: AnalyzerViewActions
}

function AnalyzerToolbar({ state, plot, actions }: AnalyzerViewProps): React.JSX.Element {
  const hasDatasets = state.datasets.length > 0
  const comparing = isComparing(state.mode)
  const showingAll = isShowingAll(state.mode)
  const showingGQuality = isGQuality(state.mode)

  const zoomIn = () => {
    const span = plot.viewport.max - plot.viewport.min
    const centre = (plot.viewport.max + plot.viewport.min) / 2
    actions.setViewport({ min: centre - span / 4, max: centre + span / 4 })
  }

  const zoomOut = () => {
    const span = plot.viewport.max - plot.viewport.min
    const centre = (plot.viewport.max + plot.viewport.min) / 2
    actions.setViewport({
      min: Math.max(plot.bounds.min, centre - span),
      max: Math.min(plot.bounds.max, centre + span),
    })
  }

  const changeSensor = (value: string) => {
    const next = { ...state.config, graph_sensor_mode: sensorModeFrom(value) }
    actions.setConfig(next)
    saveConfig(next)
  }

  return (
    <CommandBar
      trailing={
        <div className="command-bar__group">
          <button
            type="button"
            className="button"
            disabled={state.active === null}
            onClick={() => void actions.exportData('xlsx')}
          >
            Excelで書き出す
          </button>
          <button
            type="button"
            className="button"
            disabled={state.active === null}
            onClick={() => void actions.exportData('csv')}
          >
            CSVで書き出す
          </button>
          <button
            type="button"
            className="button"
            disabled={plot.canvas === null}
            title={PNG_PARITY_NOTICE}
            onClick={() => void actions.exportPng()}
          >
            PNGを保存
          </button>
          <button type="button" className="button button--flat" onClick={() => actions.setSettingsOpen(true)}>
            設定
          </button>
        </div>
      }
    >
      <FileOpenControl onFiles={actions.openFiles} />
      <fieldset className="command-bar__group segmented">
        <legend className="visually-hidden">表示モード</legend>
        <button
          type="button"
          className="button"
          aria-pressed={!showingAll && !showingGQuality}
          disabled={!hasDatasets}
          onClick={() => actions.applyModeEvent(showingAll ? 'SHOW_ALL_OFF' : 'G_QUALITY_OFF')}
        >
          通常
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={showingAll}
          disabled={!hasDatasets || showingGQuality}
          onClick={() => actions.applyModeEvent(showingAll ? 'SHOW_ALL_OFF' : 'SHOW_ALL_ON')}
        >
          全データ
        </button>
        <button
          type="button"
          className="button"
          aria-pressed={showingGQuality}
          disabled={!hasDatasets}
          onClick={() => actions.applyModeEvent(showingGQuality ? 'G_QUALITY_OFF' : 'G_QUALITY_ON')}
        >
          G-quality
        </button>
      </fieldset>
      <div className="command-bar__group">
        <button
          type="button"
          className="button"
          aria-pressed={comparing}
          disabled={state.datasets.length < 2 && !comparing}
          onClick={() => (comparing ? actions.applyModeEvent('LEAVE_COMPARING') : actions.startComparison())}
        >
          比較
        </button>
      </div>
      <div className="command-bar__group">
        <label className="field">
          <span className="visually-hidden">表示するセンサー</span>
          <select
            className="select"
            value={state.config.graph_sensor_mode}
            onChange={(event) => changeSensor(event.target.value)}
          >
            <option value="both">両方</option>
            <option value="inner_only">Inner Capsule のみ</option>
            <option value="drag_only">Drag Shield のみ</option>
          </select>
        </label>
      </div>
      <div className="command-bar__group">
        <button
          type="button"
          className="button"
          onClick={() => actions.setViewport(null)}
          disabled={!hasDatasets}
        >
          全体表示
        </button>
        <button type="button" className="button" disabled={!hasDatasets} onClick={zoomIn}>
          拡大
        </button>
        <button type="button" className="button" disabled={!hasDatasets} onClick={zoomOut}>
          縮小
        </button>
      </div>
    </CommandBar>
  )
}

function FileOpenControl({ onFiles }: { onFiles: (files: File[]) => Promise<void> }): React.JSX.Element {
  return (
    <div className="command-bar__group">
      <label className="button">
        ファイルを開く
        <input
          className="visually-hidden"
          type="file"
          accept=".csv,text/csv"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])]
            if (files.length > 0) void onFiles(files)
            event.target.value = ''
          }}
        />
      </label>
    </div>
  )
}

function GraphArea({ state, plot, actions }: AnalyzerViewProps): React.JSX.Element {
  const running = state.statuses.analysis.kind === 'running' ? state.statuses.analysis : null
  return (
    <main className="graph-area">
      <h1 className="visually-hidden">加速度データ解析</h1>
      <NoticeStack notices={state.notices} onDismiss={actions.dismissNotice} />
      {running === null ? null : (
        <progress className="progress" max={100} value={running.percent}>
          {running.percent}%
        </progress>
      )}
      {state.datasets.length === 0 ? (
        <FileDropZone onFiles={(files) => void actions.openFiles(files)} disabled={false} />
      ) : (
        <UPlotChart
          model={plot.model}
          palette={plot.palette}
          viewport={plot.viewport}
          onViewportChange={actions.setViewport}
          bounds={plot.bounds}
          onGeometryChange={actions.setGeometry}
          onCanvasChange={actions.setCanvas}
          primaryDragReserved={state.selectionEnabled}
        >
          <SelectionOverlay
            geometry={plot.geometry}
            selection={state.selection}
            onSelectionChange={actions.setSelection}
            enabled={state.selectionEnabled}
          />
        </UPlotChart>
      )}
    </main>
  )
}

function DatasetPanel({ state, actions }: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const selectDataset = (name: string) => {
    actions.setActiveName(name)
    actions.setSelection(null)
    actions.setViewport(null)
  }
  return (
    <section className="panel" aria-label="データセット">
      <div className="panel__header">
        <h2 className="panel__title">データセット</h2>
        <span className="panel__hint">{state.datasets.length} 件</span>
      </div>
      <ul className="dataset-list">
        {state.datasets.map((dataset) => (
          <li className="dataset-list__item" key={dataset.name}>
            <button
              type="button"
              className="button button--flat dataset-list__name"
              aria-current={dataset.name === state.activeName}
              onClick={() => selectDataset(dataset.name)}
            >
              {dataset.name}
            </button>
            {dataset.fromCache ? <span className="panel__hint">キャッシュ</span> : null}
            <button
              type="button"
              className="button button--flat"
              aria-label={`${dataset.name} を閉じる`}
              onClick={() => actions.closeDataset(dataset)}
            >
              閉じる
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function openedSourceFrom(dataset: Dataset): OpenedSource {
  return {
    sourceSha256: dataset.sourceSha256,
    filename: dataset.filename,
    encoding: dataset.encoding,
    columnNames: [...dataset.columnNames],
    detected: { time: [], acceleration: [] },
    rowCount: dataset.sampleCount,
    suggestedMapping: dataset.mapping,
    ambiguity: null,
  }
}

function FileInfoPanel({ state, actions }: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const editColumns = () => {
    if (state.active === null) return
    actions.setPendingColumns({
      source: openedSourceFrom(state.active),
      initial: state.active.mapping,
      reason: undefined,
    })
  }
  return (
    <section className="panel" aria-label="ファイル情報">
      <div className="panel__header">
        <h2 className="panel__title">ファイル情報</h2>
      </div>
      {state.active === null ? (
        <p className="panel__hint">データセットを選択してください。</p>
      ) : (
        <div {...TABLE_SCROLL_PROPS}>
          <table className="data-table">
            <tbody>
              <tr>
                <th scope="row">文字コード</th>
                <td>{state.active.encoding}</td>
              </tr>
              <tr>
                <th scope="row">行数</th>
                <td className="numeric">{state.active.sampleCount.toLocaleString()}</td>
              </tr>
              <tr>
                <th scope="row">時間列</th>
                <td>{state.active.mapping.timeColumn}</td>
              </tr>
              <tr>
                <th scope="row">Inner Capsule</th>
                <td>{state.active.mapping.useInner ? state.active.mapping.innerColumn : '未使用'}</td>
              </tr>
              <tr>
                <th scope="row">Drag Shield</th>
                <td>{state.active.mapping.useDrag ? state.active.mapping.dragColumn : '未使用'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="button" disabled={state.active === null} onClick={editColumns}>
        列を選び直す
      </button>
    </section>
  )
}

function AnalyzerSidebar({
  state,
  actions,
}: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const statisticsDatasets = isComparing(state.mode)
    ? state.datasets
    : state.active === null
      ? []
      : [state.active]
  const posterStatus = state.posterContext === null ? { kind: 'unavailable' as const } : state.statuses.poster
  return (
    <aside className="side-panel">
      <DatasetPanel state={state} actions={actions} />
      <StatisticsPanel datasets={statisticsDatasets} mode={state.mode} />
      <RangeStatisticsPanel
        selection={state.selection}
        result={state.rangeResult}
        enabled={state.selectionEnabled}
        onChange={actions.setSelection}
      />
      <PosterPanel
        context={state.posterContext}
        unavailableReason={state.posterUnavailableReason}
        status={posterStatus}
        selection={state.selectionEnabled ? state.selection : null}
        selectionEnabled={state.selectionEnabled}
        yRange={{ min: state.config.ylim_min, max: state.config.ylim_max }}
        onRetryAuto={actions.retryPoster}
        customPosters={state.activeCustomPosters}
        onCustomCreated={actions.addCustomPoster}
      />
      <FileInfoPanel state={state} actions={actions} />
    </aside>
  )
}

function AnalyzerDialogs({
  state,
  actions,
}: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const applySettings = (next: AnalysisConfig) => {
    actions.setConfig(next)
    if (!saveConfig(next))
      actions.notify('warning', '設定をブラウザに保存できませんでした。今回のセッションのみ有効です。')
    actions.setSettingsOpen(false)
  }
  const confirmColumns = (mapping: ColumnMapping) => {
    if (state.pendingColumns === null) return
    const source = state.pendingColumns.source
    actions.setPendingColumns(null)
    void actions.runAnalysis(source, mapping)
  }
  return (
    <>
      {state.pendingColumns === null ? null : (
        <ColumnSelectorDialog
          source={state.pendingColumns.source}
          initial={state.pendingColumns.initial}
          reason={state.pendingColumns.reason}
          onCancel={() => actions.setPendingColumns(null)}
          onConfirm={confirmColumns}
        />
      )}
      {state.settingsOpen ? (
        <SettingsDialog
          config={state.config}
          onCancel={() => actions.setSettingsOpen(false)}
          onApply={applySettings}
          onClearCache={() =>
            void clearCache().then(() => actions.notify('info', 'ローカルキャッシュを削除しました。'))
          }
        />
      ) : null}
    </>
  )
}

export function AnalyzerView(props: AnalyzerViewProps): React.JSX.Element {
  const { state, actions } = props
  const hasDatasets = state.datasets.length > 0
  const addCustomPoster = (poster: PosterFigure) => {
    actions.addCustomPoster(poster)
    actions.notify('info', 'ポスター図を作成しました。')
  }
  const viewProps = { ...props, actions: { ...actions, addCustomPoster } }
  return (
    <div className="app">
      <AnalyzerToolbar {...viewProps} />
      <div className={hasDatasets ? 'workspace' : 'workspace workspace--single'}>
        <GraphArea {...viewProps} />
        {hasDatasets ? <AnalyzerSidebar state={state} actions={viewProps.actions} /> : null}
      </div>
      <CloudStatusBar
        statuses={state.statuses}
        onRetrySync={actions.retrySync}
        onRetryPoster={actions.retryPoster}
      />
      <AnalyzerDialogs state={state} actions={actions} />
    </div>
  )
}
