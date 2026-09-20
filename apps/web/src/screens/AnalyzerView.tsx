import type { AnalysisConfig } from '@aat/shared'
import { type Dispatch, type SetStateAction, useRef, useState } from 'react'
import type { ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import type { Dataset } from '../app/dataset.ts'
import { openedSourceForDataset } from '../app/dataset.ts'
import type { RangeStatisticsResult } from '../app/range-statistics.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import type { CloudStatuses } from '../cloud/status.ts'
import { CloudStatusBar } from '../components/CloudStatusBar.tsx'
import { csvFilesFrom, FileDropZone } from '../components/FileDropZone.tsx'
import { HintBar, Kbd } from '../components/HintBar.tsx'
import { type NoticeItem, NoticeStack } from '../components/NoticeStack.tsx'
import { RangeStatisticsPanel } from '../components/RangeStatisticsPanel.tsx'
import { StatisticsPanel } from '../components/StatisticsPanel.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import type { PlotModel } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { GraphPalette } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import { isComparing, type ViewMode } from '../graph/view-mode.ts'
import { PosterPanel } from '../poster/PosterPanel.tsx'
import type { PosterContext } from '../poster/requests.ts'
import { AnalyzerDialogs } from './AnalyzerDialogs.tsx'
import { AnalyzerToolbar } from './AnalyzerToolbar.tsx'

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
  /** Name of the file the cloud/poster lanes describe, or null when none has synced. */
  cloudSubject: string | null
  notices: readonly NoticeItem[]
  posterContext: PosterContext | null
  posterUnavailableReason: string | null
  activeCustomPosters: readonly PosterFigure[]
  pendingColumns: PendingColumnChoice | null
  settingsOpen: boolean
  /** First-run modal; once dismissed it is a persisted flag, not a state machine. */
  welcomeOpen: boolean
  helpOpen: boolean
  /** The one contextual hint currently allowed to show, or null. */
  hint: AnalyzerHint | null
}

export type AnalyzerHint = 'graph' | 'range' | 'compare'

/** The actions `analyzer-actions.ts` does not build — the screen supplies them itself. */
export type OnboardingActionKeys =
  | 'dismissWelcome'
  | 'openHelp'
  | 'closeHelp'
  | 'reopenWelcome'
  | 'dismissHint'
  | 'dismissAllNotices'

interface AnalyzerPlotState {
  model: PlotModel
  palette: GraphPalette
  viewport: ChartViewport
  bounds: ChartViewport
  geometry: ChartGeometry | null
  canvas: HTMLCanvasElement | null
  /** uPlot's `.u-over` element — where selection gestures actually listen. */
  gestureLayer: HTMLElement | null
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
  setGestureLayer: Dispatch<SetStateAction<HTMLElement | null>>
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
  /** Resolve the column dialog and continue any queued batch of files. */
  confirmPendingColumns: (mapping: ColumnMapping) => void
  cancelPendingColumns: () => void
  runAnalysis: (
    source: OpenedSource,
    mapping: ColumnMapping,
    configOverride?: AnalysisConfig,
  ) => Promise<void>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  dismissWelcome: () => void
  /** Open help — from the toolbar, the welcome's CTA, or the quick start. */
  openHelp: () => void
  closeHelp: () => void
  /** From help's "もう一度見る": close help and show the welcome again. */
  reopenWelcome: () => void
  dismissHint: (hint: AnalyzerHint) => void
  dismissAllNotices: () => void
  /**
   * Apply a settings edit: persists it, and re-analyses open datasets when a
   * number-changing key moved. Implemented by the screen, which owns the
   * datasets and the worker client.
   */
  applyConfig: (next: AnalysisConfig) => void
  /** Abort every in-flight worker request. */
  cancelAnalysis: () => void
}

export interface AnalyzerViewProps {
  state: AnalyzerViewState
  plot: AnalyzerPlotState
  actions: AnalyzerViewActions
}

/**
 * What each hint says. A table rather than a switch: the three differ only in
 * their copy, and the bar around them is identical.
 */
const HINT_COPY: Record<AnalyzerHint, React.JSX.Element> = {
  // Written to match UPlotChart/SelectionOverlay exactly — drag selects only
  // because the normal view reserves the primary drag for it.
  graph: (
    <>
      <b>グラフ操作</b>
      ドラッグで範囲を選択、ホイールでポインタ位置を中心にズーム、<Kbd>Shift</Kbd>
      ＋ドラッグでパン。「全体表示」で範囲をリセットします。
    </>
  ),
  range: (
    <>
      <b>範囲の統計</b>
      グラフ上をドラッグすると、その区間の統計が「選択範囲の統計情報」に表示されます。
    </>
  ),
  compare: (
    <>
      <b>比較</b>
      2つ目のデータセットを開きました。ツールバーの「比較」で同じグラフに重ねて表示できます。
    </>
  ),
}

function AnalyzerHintBar({
  hint,
  onDismiss,
}: {
  hint: AnalyzerHint
  onDismiss: (hint: AnalyzerHint) => void
}): React.JSX.Element {
  return <HintBar onDismiss={() => onDismiss(hint)}>{HINT_COPY[hint]}</HintBar>
}

/**
 * The graph area's file-drop handlers. Dropping is how the second file of a
 * comparison arrives; the full-size dropzone only exists for the first file,
 * so the graph itself answers a file drag once datasets are open.
 */
function useFileDrop(onFiles: (files: File[]) => Promise<void>) {
  const [dropping, setDropping] = useState(false)
  const dropDepth = useRef(0)
  const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes('Files')
  return {
    dropping,
    onDragEnter: (event: React.DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      // Counted rather than toggled: child boundaries fire enter/leave pairs.
      dropDepth.current += 1
      setDropping(true)
    },
    onDragOver: (event: React.DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      dropDepth.current = Math.max(0, dropDepth.current - 1)
      if (dropDepth.current === 0) setDropping(false)
    },
    onDrop: (event: React.DragEvent) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      dropDepth.current = 0
      setDropping(false)
      const files = csvFilesFrom(event.dataTransfer.files)
      if (files.length > 0) void onFiles(files)
    },
  }
}

/**
 * Everything layered over the plot: the drop affordance, the notice stack, the
 * one contextual hint, and the progress bar. Kept apart from the plot itself so
 * the graph area reads as "the chrome, then either the drop zone or the chart".
 */
function GraphOverlays({
  state,
  actions,
  dropping,
}: Pick<AnalyzerViewProps, 'state' | 'actions'> & { dropping: boolean }): React.JSX.Element {
  const running = state.statuses.analysis.kind === 'running' ? state.statuses.analysis : null
  return (
    <>
      {dropping ? (
        <div className="graph-area__drop-hint" aria-hidden="true">
          CSVファイルをドロップして追加
        </div>
      ) : null}
      <NoticeStack
        notices={state.notices}
        onDismiss={actions.dismissNotice}
        onDismissAll={actions.dismissAllNotices}
      />
      {state.hint === null ? null : <AnalyzerHintBar hint={state.hint} onDismiss={actions.dismissHint} />}
      {running === null ? null : (
        <div className="analysis-progress">
          <progress className="progress" max={100} value={running.percent}>
            {running.percent}%
          </progress>
          <button type="button" className="button button--flat" onClick={actions.cancelAnalysis}>
            中止
          </button>
        </div>
      )}
    </>
  )
}

function GraphArea({ state, plot, actions }: AnalyzerViewProps): React.JSX.Element {
  const fileDrop = useFileDrop(actions.openFiles)
  return (
    <main
      className="graph-area"
      id="aat-graph"
      tabIndex={-1}
      onDragEnter={fileDrop.onDragEnter}
      onDragOver={fileDrop.onDragOver}
      onDragLeave={fileDrop.onDragLeave}
      onDrop={fileDrop.onDrop}
    >
      <h1 className="visually-hidden">加速度データ解析</h1>
      <GraphOverlays state={state} actions={actions} dropping={fileDrop.dropping} />
      {state.datasets.length === 0 ? (
        <FileDropZone
          onFiles={(files) => void actions.openFiles(files)}
          disabled={false}
          onHelp={actions.openHelp}
        />
      ) : (
        <UPlotChart
          model={plot.model}
          palette={plot.palette}
          viewport={plot.viewport}
          onViewportChange={actions.setViewport}
          bounds={plot.bounds}
          onGeometryChange={actions.setGeometry}
          onCanvasChange={actions.setCanvas}
          onGestureLayerChange={actions.setGestureLayer}
          primaryDragReserved={state.selectionEnabled}
        >
          <SelectionOverlay
            geometry={plot.geometry}
            selection={state.selection}
            onSelectionChange={actions.setSelection}
            enabled={state.selectionEnabled}
            gestureLayer={plot.gestureLayer}
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

/** A mapping row's value: the chosen column, or the word for "not used". */
function columnLabel(used: boolean, column: string): string {
  return used ? column : '未使用'
}

function FileInfoPanel({ state, actions }: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const editColumns = () => {
    if (state.active === null) return
    actions.setPendingColumns({
      source: openedSourceForDataset(state.active),
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
                <td>{columnLabel(state.active.mapping.useInner, state.active.mapping.innerColumn)}</td>
              </tr>
              <tr>
                <th scope="row">Drag Shield</th>
                <td>{columnLabel(state.active.mapping.useDrag, state.active.mapping.dragColumn)}</td>
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

/**
 * Which datasets the statistics panel describes: every open one while
 * comparing, otherwise the active one alone — and nothing when none is active.
 */
function statisticsDatasetsFor(
  mode: ViewMode,
  datasets: readonly Dataset[],
  active: Dataset | null,
): readonly Dataset[] {
  if (isComparing(mode)) return datasets
  return active === null ? [] : [active]
}

function AnalyzerSidebar({
  state,
  actions,
}: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const statisticsDatasets = statisticsDatasetsFor(state.mode, state.datasets, state.active)
  const posterStatus = state.posterContext === null ? { kind: 'unavailable' as const } : state.statuses.poster
  return (
    <aside className="side-panel" aria-label="データセットと統計">
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
        // ylim is display framing, not numeric provenance: it is outside `configHash`, so a
        // dataset's numbers never depend on it, and the poster should match the graph the user
        // is looking at now — read the live config, not the dataset's producing one.
        yRange={{ min: state.config.ylim_min, max: state.config.ylim_max }}
        onRetryAuto={actions.retryPoster}
        customPosters={state.activeCustomPosters}
        onCustomCreated={actions.addCustomPoster}
        onCustomFailed={(message) => actions.notify('error', message)}
      />
      <FileInfoPanel state={state} actions={actions} />
    </aside>
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
      {/* The toolbar is the whole tab order before the graph; one jump past it
          is the entire reason for the link. */}
      <a className="skip-link" href="#aat-graph">
        グラフへ移動
      </a>
      <AnalyzerToolbar {...viewProps} />
      <div className={hasDatasets ? 'workspace' : 'workspace workspace--single'}>
        <GraphArea {...viewProps} />
        {hasDatasets ? <AnalyzerSidebar state={state} actions={viewProps.actions} /> : null}
      </div>
      <CloudStatusBar
        statuses={state.statuses}
        cloudSubject={state.cloudSubject}
        activeName={state.activeName}
        onRetrySync={actions.retrySync}
        onRetryPoster={actions.retryPoster}
      />
      <AnalyzerDialogs state={state} actions={actions} />
    </div>
  )
}
