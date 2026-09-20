/**
 * The analyzer's command bar.
 *
 * Kept out of AnalyzerView.tsx: the bar is dense wiring of controls to
 * `actions`, and the screen file reads better without it.
 */

import { sensorModeFrom } from '../app/dataset.ts'
import { saveConfig } from '../app/settings.ts'
import { CommandBar } from '../components/CommandBar.tsx'
import { InfoTip } from '../components/InfoTip.tsx'
import { PNG_PARITY_NOTICE } from '../exporting/png.ts'
import { isComparing, isGQuality, isShowingAll } from '../graph/view-mode.ts'
import type { AnalyzerViewProps } from './AnalyzerView.tsx'

/** The export and settings controls on the toolbar's trailing side. */
function ExportButtons({ state, plot, actions }: AnalyzerViewProps): React.JSX.Element {
  return (
    <div className="command-bar__group">
      <button
        type="button"
        className="button button--flat"
        disabled={state.active === null}
        onClick={() => void actions.exportData('xlsx')}
      >
        Excelで書き出す
      </button>
      <button
        type="button"
        className="button button--flat"
        disabled={state.active === null}
        onClick={() => void actions.exportData('csv')}
      >
        CSVで書き出す
      </button>
      <button
        type="button"
        className="button button--flat"
        disabled={plot.canvas === null}
        title={PNG_PARITY_NOTICE}
        aria-describedby="png-parity-hint"
        onClick={() => void actions.exportPng()}
      >
        PNGを保存
      </button>
      {/* A `title` tooltip never reaches touch or screen-reader users; the
          parity caveat is worth one line of hidden text. */}
      <span id="png-parity-hint" className="visually-hidden">
        {PNG_PARITY_NOTICE}
      </span>
      <button
        type="button"
        className="button button--flat"
        aria-label="操作ガイド"
        title="操作ガイド"
        onClick={actions.openHelp}
      >
        ?
      </button>
      <button type="button" className="button button--flat" onClick={() => actions.setSettingsOpen(true)}>
        設定
      </button>
    </div>
  )
}

/** The normal / show-all / G-quality segmented control. */
function ViewModeButtons({
  state,
  actions,
}: Pick<AnalyzerViewProps, 'state' | 'actions'>): React.JSX.Element {
  const hasDatasets = state.datasets.length > 0
  const showingAll = isShowingAll(state.mode)
  const showingGQuality = isGQuality(state.mode)
  return (
    <fieldset className="segmented">
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
  )
}

export function AnalyzerToolbar({ state, plot, actions }: AnalyzerViewProps): React.JSX.Element {
  const hasDatasets = state.datasets.length > 0
  const comparing = isComparing(state.mode)

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
    <CommandBar trailing={<ExportButtons state={state} plot={plot} actions={actions} />}>
      <FileOpenControl onFiles={actions.openFiles} />
      <div className="command-bar__group">
        <ViewModeButtons state={state} actions={actions} />
        <InfoTip
          label="表示モード"
          text="通常：補正済みの重力レベルを表示します。全データ：補正前を含む全系列を重ねます。G-quality：重力レベルと品質指標を確認します。"
        />
      </div>
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
        <InfoTip label="比較" text="2つ以上のデータセットを開くと、同じグラフ上に重ねて表示できます。" />
      </div>
      <div className="command-bar__group">
        <label className="command-bar__label" htmlFor="sensor-select">
          センサー
        </label>
        <select
          id="sensor-select"
          className="select"
          value={state.config.graph_sensor_mode}
          onChange={(event) => changeSensor(event.target.value)}
        >
          <option value="both">両方</option>
          <option value="inner_only">Inner Capsule のみ</option>
          <option value="drag_only">Drag Shield のみ</option>
        </select>
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
      <label className="button button--primary">
        ファイルを開く
        <input
          id="aat-file-open"
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
