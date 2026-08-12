/**
 * The application shell.
 *
 * Holds the session state — open datasets, the view mode, the selection, the
 * viewport, the three cloud statuses — and wires the pieces together. It owns no
 * arithmetic: the numbers come from the analysis worker, the plot content from
 * `plot-model.ts`, the selection maths from `selection.ts`. That separation is
 * what keeps the interesting logic testable without a DOM, which matters here
 * because jsdom is deliberately not a dependency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnalysisConfig } from '@aat/shared'
import { AnalysisClient, type AnalysisProgress, AnalysisWorkerError } from '../analysis/client.ts'
import { defaultDialogMapping } from '../analysis/mapping.ts'
import type { ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import { clearCache } from '../cache/analysis-cache.ts'
import { CloudStatusBar } from '../components/CloudStatusBar.tsx'
import { ColumnSelectorDialog } from '../components/ColumnSelectorDialog.tsx'
import { FileDropZone } from '../components/FileDropZone.tsx'
import { RangeStatisticsPanel } from '../components/RangeStatisticsPanel.tsx'
import { SettingsDialog } from '../components/SettingsDialog.tsx'
import { StatisticsPanel } from '../components/StatisticsPanel.tsx'
import { fetchPoster, fetchSession, requestPoster } from '../cloud/gateway.ts'
import { type CloudStatuses, INITIAL_STATUSES } from '../cloud/status.ts'
import { syncDataset } from '../cloud/sync.ts'
import { ExportClient, ExportTooLargeForWorksheet, saveBlob } from '../exporting/client.ts'
import { workbookInputFor } from '../exporting/input.ts'
import { canvasToPng, PNG_PARITY_NOTICE } from '../exporting/png.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import { buildPlotModel, modelDataRange } from '../graph/plot-model.ts'
import { SelectionOverlay } from '../graph/SelectionOverlay.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import { graphPalette, prefersDarkScheme, resolveTheme, themeSettingFrom } from '../graph/theme.ts'
import { type ChartViewport, UPlotChart } from '../graph/UPlotChart.tsx'
import {
  canSelectRange,
  isComparing,
  isGQuality,
  isShowingAll,
  transition,
  type ViewMode,
} from '../graph/view-mode.ts'
import { type Dataset, datasetFromPayload, sensorModeFrom } from './dataset.ts'
import { rangeStatisticsFor } from './range-statistics.ts'
import { loadConfig, saveConfig } from './settings.ts'
import { APP_VERSION } from './version.ts'

interface Notice {
  id: number
  tone: 'info' | 'warning' | 'error'
  text: string
}

interface PendingColumnChoice {
  source: OpenedSource
  initial: ColumnMapping
  reason: string | undefined
}

export function App(): React.JSX.Element {
  const [config, setConfig] = useState<AnalysisConfig>(loadConfig)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('NORMAL')
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const [viewport, setViewport] = useState<ChartViewport | null>(null)
  const [geometry, setGeometry] = useState<ChartGeometry | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [statuses, setStatuses] = useState<CloudStatuses>(INITIAL_STATUSES)
  const [pendingColumns, setPendingColumns] = useState<PendingColumnChoice | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notices, setNotices] = useState<Notice[]>([])
  const [signedIn, setSignedIn] = useState(false)
  const [lastRevisionId, setLastRevisionId] = useState<string | null>(null)

  const analysisClient = useRef<AnalysisClient | null>(null)
  const exportClient = useRef<ExportClient | null>(null)
  const noticeId = useRef(0)

  const getAnalysisClient = () => {
    analysisClient.current ??= new AnalysisClient()
    return analysisClient.current
  }
  const getExportClient = () => {
    exportClient.current ??= new ExportClient()
    return exportClient.current
  }

  useEffect(
    () => () => {
      analysisClient.current?.dispose()
      exportClient.current?.dispose()
    },
    [],
  )

  const notify = useCallback((tone: Notice['tone'], text: string) => {
    noticeId.current += 1
    const id = noticeId.current
    setNotices((current) => [...current, { id, tone, text }])
  }, [])

  const dismissNotice = (id: number) => setNotices((current) => current.filter((n) => n.id !== id))

  /* ---------------------------------------------------------------- theme */

  const [systemDark, setSystemDark] = useState(prefersDarkScheme)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])

  const theme = resolveTheme(themeSettingFrom(config.theme), systemDark)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const palette = useMemo(() => graphPalette(theme), [theme])

  /* --------------------------------------------------------------- cloud */

  useEffect(() => {
    // One probe at start-up. A negative answer is the normal, fully functional
    // local-only mode, so nothing is retried and nothing is surfaced as a fault.
    void fetchSession().then((outcome) => {
      setSignedIn(outcome.ok && outcome.value !== null)
    })
  }, [])

  /* ------------------------------------------------------------ datasets */

  const active = useMemo(
    () => datasets.find((dataset) => dataset.name === activeName) ?? null,
    [datasets, activeName],
  )

  const plotModel = useMemo(
    () =>
      buildPlotModel({
        datasets,
        active,
        mode,
        sensorMode: sensorModeFrom(config.graph_sensor_mode),
        palette,
        ylimMin: config.ylim_min,
        ylimMax: config.ylim_max,
        defaultGraphDuration: config.default_graph_duration,
      }),
    [datasets, active, mode, config, palette],
  )

  const dataRange = useMemo(() => modelDataRange(plotModel), [plotModel])

  const defaultViewport = useMemo((): ChartViewport => {
    if (plotModel.xRange !== null) return { min: plotModel.xRange[0], max: plotModel.xRange[1] }
    if (dataRange !== null && dataRange.max > dataRange.min) return { min: dataRange.min, max: dataRange.max }
    return { min: 0, max: config.default_graph_duration }
  }, [plotModel, dataRange, config.default_graph_duration])

  const bounds = useMemo((): ChartViewport => {
    if (dataRange === null) return defaultViewport
    // Zooming out is bounded by the data plus whatever fixed window the mode
    // pins, so a reset always lands somewhere meaningful.
    return {
      min: Math.min(dataRange.min, defaultViewport.min),
      max: Math.max(dataRange.max, defaultViewport.max),
    }
  }, [dataRange, defaultViewport])

  // `null` means "follow the mode's default framing". Switching dataset or mode
  // clears it, which is how the desktop re-frames the graph on both.
  const effectiveViewport = viewport ?? defaultViewport

  const selectionEnabled = canSelectRange(mode)
  const rangeResult = useMemo(() => {
    if (active === null || selection === null || !selectionEnabled) return null
    return rangeStatisticsFor(active, selection)
  }, [active, selection, selectionEnabled])

  /* ---------------------------------------------------------------- cloud */

  const applyPosterState = useCallback((state: { status: string; url?: string; message?: string }) => {
    if (state.status === 'ready' && state.url !== undefined) {
      setStatuses((current) => ({ ...current, poster: { kind: 'ready', url: state.url as string } }))
      return
    }
    if (state.status === 'failed') {
      setStatuses((current) => ({
        ...current,
        poster: { kind: 'failed', message: state.message ?? 'ポスターの生成に失敗しました。', retryable: true },
      }))
      return
    }
    setStatuses((current) => ({
      ...current,
      poster: { kind: state.status === 'rendering' ? 'rendering' : 'queued' },
    }))
  }, [])

  const syncToCloud = useCallback(
    async (dataset: Dataset) => {
      setStatuses((current) => ({ ...current, sync: { kind: 'saving' } }))
      const outcome = await syncDataset(dataset, config)
      if (!outcome.ok) {
        setStatuses((current) => ({
          ...current,
          sync: {
            kind: 'failed',
            message: outcome.kind === 'unavailable' ? outcome.message : outcome.message,
            retryable: outcome.kind === 'unavailable' || outcome.retryable,
          },
        }))
        return
      }
      const revisionId = outcome.value.revisionId
      setLastRevisionId(revisionId)
      setStatuses((current) => ({
        ...current,
        sync: { kind: 'saved', revisionId, at: Date.now() },
        poster: { kind: 'queued' },
      }))

      // Poster generation is a separate lane on purpose: it can be slow, it can
      // fail, and neither outcome touches the analysis the user already has.
      const posterOutcome = await requestPoster(revisionId)
      if (!posterOutcome.ok) {
        setStatuses((current) => ({
          ...current,
          poster: {
            kind: 'failed',
            message: posterOutcome.message,
            retryable: posterOutcome.kind === 'unavailable' || posterOutcome.retryable,
          },
        }))
        return
      }
      applyPosterState(posterOutcome.value)
    },
    [config, applyPosterState],
  )

  /* ------------------------------------------------------------- opening */

  const runAnalysis = useCallback(
    async (source: OpenedSource, mapping: ColumnMapping) => {
      const client = getAnalysisClient()
      const onProgress = (progress: AnalysisProgress) => {
        setStatuses((current) => ({
          ...current,
          analysis: { kind: 'running', stage: progress.stage, percent: progress.percent },
        }))
      }

      try {
        const result = await client.analyse(
          {
            sourceSha256: source.sourceSha256,
            filename: source.filename,
            config,
            mapping,
            skipGQuality: !config.auto_calculate_g_quality,
            useCache: config.use_cache,
          },
          onProgress,
        )
        const dataset = datasetFromPayload(result.payload, result.fromCache)
        setDatasets((current) => [
          ...current.filter((existing) => existing.name !== dataset.name),
          dataset,
        ])
        setActiveName(dataset.name)
        setSelection(null)
        setViewport(null)
        setStatuses((current) => ({
          ...current,
          analysis: { kind: 'ready', fromCache: result.fromCache },
        }))

        for (const warning of dataset.warnings) {
          notify('warning', `${dataset.name}: ${warning.message}`)
        }

        // The local analysis is finished and usable at this point. Everything
        // below is optional and must never gate it.
        if (signedIn) void syncToCloud(dataset)
      } catch (error) {
        if (error instanceof AnalysisWorkerError && error.code === 'COLUMN_NOT_FOUND') {
          // The desktop answers this by reopening column selection; so do we,
          // rather than presenting a dead end.
          setPendingColumns({
            source,
            initial: mapping,
            reason: `次の列が見つかりませんでした: ${error.missingColumns.join(', ')}\n使用する列を選び直してください。`,
          })
          setStatuses((current) => ({ ...current, analysis: { kind: 'idle' } }))
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof AnalysisWorkerError ? error.code : 'INTERNAL'
        setStatuses((current) => ({ ...current, analysis: { kind: 'failed', message, code } }))
        notify('error', `${source.filename}: ${message}`)
      }
    },
    [config, signedIn, notify, syncToCloud],
  )

  const openFiles = useCallback(
    async (files: File[]) => {
      const client = getAnalysisClient()
      for (const file of files) {
        setStatuses((current) => ({
          ...current,
          analysis: { kind: 'running', stage: 'decoding', percent: 0 },
        }))
        try {
          const bytes = await file.arrayBuffer()
          const source = await client.open(file.name, bytes, (progress) => {
            setStatuses((current) => ({
              ...current,
              analysis: { kind: 'running', stage: progress.stage, percent: progress.percent },
            }))
          })
          if (source.suggestedMapping === null) {
            // Ambiguous or missing candidates: ask, rather than guess. A wrong
            // guess does not fail — it produces a believable graph of the wrong
            // column, which is far worse.
            setPendingColumns({
              source,
              initial: defaultDialogMapping(source.detected),
              reason: undefined,
            })
            setStatuses((current) => ({ ...current, analysis: { kind: 'idle' } }))
            return
          }
          await runAnalysis(source, source.suggestedMapping)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof AnalysisWorkerError ? error.code : 'INTERNAL'
          setStatuses((current) => ({ ...current, analysis: { kind: 'failed', message, code } }))
          notify('error', `${file.name}: ${message}`)
        }
      }
    },
    [runAnalysis, notify],
  )

  const closeDataset = useCallback(
    (dataset: Dataset) => {
      setDatasets((current) => current.filter((existing) => existing.name !== dataset.name))
      setActiveName((current) => (current === dataset.name ? null : current))
      void getAnalysisClient().release(dataset.sourceSha256)
    },
    [],
  )

  const retrySync = () => {
    if (active === null) return
    void syncToCloud(active)
  }

  const retryPoster = () => {
    if (lastRevisionId === null) return
    setStatuses((current) => ({ ...current, poster: { kind: 'queued' } }))
    void fetchPoster(lastRevisionId).then((outcome) => {
      if (!outcome.ok) {
        setStatuses((current) => ({
          ...current,
          poster: {
            kind: 'failed',
            message: outcome.message,
            retryable: outcome.kind === 'unavailable' || outcome.retryable,
          },
        }))
        return
      }
      applyPosterState(outcome.value)
    })
  }

  /* --------------------------------------------------------------- modes */

  const applyEvent = (event: Parameters<typeof transition>[1]) => {
    setMode((current) => {
      const next = transition(current, event)
      // Leaving the normal view invalidates a selection: every other view either
      // has no time axis or has several, so the span would no longer mean the
      // thing it was drawn over.
      if (!canSelectRange(next)) setSelection(null)
      return next
    })
    setViewport(null)
  }

  const startComparison = () => {
    if (datasets.length < 2) {
      notify('warning', '比較するには少なくとも2つのファイルが必要です。')
      return
    }
    applyEvent('ENTER_COMPARING')
  }

  /* -------------------------------------------------------------- export */

  const doExport = async (format: 'xlsx' | 'csv') => {
    if (active === null) return
    const input = workbookInputFor(
      active,
      config.sampling_rate,
      rangeResult === null
        ? null
        : { range: rangeResult.range, inner: rangeResult.inner, drag: rangeResult.drag },
    )
    try {
      const result = await getExportClient().run(format, input)
      saveBlob(result.blob, `${active.name}.${format === 'xlsx' ? 'xlsx' : 'csv'}`)
      notify('info', `${active.name} を書き出しました。`)
    } catch (error) {
      if (error instanceof ExportTooLargeForWorksheet) {
        // Never truncate. Say how big it is and offer the format that has no
        // row limit.
        notify(
          'warning',
          `${error.message}\n「CSVで書き出す」を選ぶと、行数制限なしで保存できます。`,
        )
        return
      }
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }

  const doPngExport = async () => {
    if (canvas === null) {
      notify('warning', 'グラフが表示されていないため、PNGを保存できません。')
      return
    }
    try {
      const blob = await canvasToPng(canvas, { scale: 2, background: palette.background })
      saveBlob(blob, `${active?.name ?? 'graph'}_gl.png`)
      notify('info', PNG_PARITY_NOTICE)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    }
  }

  /* --------------------------------------------------------------- render */

  const hasDatasets = datasets.length > 0

  return (
    <div className="app">
      <header className="command-bar">
        <div className="command-bar__brand">
          <span className="command-bar__title">AAT</span>
          <span className="command-bar__version">v{APP_VERSION}</span>
        </div>

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
                if (files.length > 0) void openFiles(files)
                event.target.value = ''
              }}
            />
          </label>
        </div>

        <div className="command-bar__group segmented" role="group" aria-label="表示モード">
          <button
            type="button"
            className="button"
            aria-pressed={!isShowingAll(mode) && !isGQuality(mode)}
            disabled={!hasDatasets}
            onClick={() => applyEvent(isShowingAll(mode) ? 'SHOW_ALL_OFF' : 'G_QUALITY_OFF')}
          >
            通常
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={isShowingAll(mode)}
            disabled={!hasDatasets || isGQuality(mode)}
            onClick={() => applyEvent(isShowingAll(mode) ? 'SHOW_ALL_OFF' : 'SHOW_ALL_ON')}
          >
            全データ
          </button>
          <button
            type="button"
            className="button"
            aria-pressed={isGQuality(mode)}
            disabled={!hasDatasets}
            onClick={() => applyEvent(isGQuality(mode) ? 'G_QUALITY_OFF' : 'G_QUALITY_ON')}
          >
            G-quality
          </button>
        </div>

        <div className="command-bar__group">
          <button
            type="button"
            className="button"
            aria-pressed={isComparing(mode)}
            disabled={datasets.length < 2 && !isComparing(mode)}
            onClick={() => (isComparing(mode) ? applyEvent('LEAVE_COMPARING') : startComparison())}
          >
            比較
          </button>
        </div>

        <div className="command-bar__group">
          <label className="field">
            <span className="visually-hidden">表示するセンサー</span>
            <select
              className="select"
              value={config.graph_sensor_mode}
              onChange={(event) => {
                const next = { ...config, graph_sensor_mode: sensorModeFrom(event.target.value) }
                setConfig(next)
                saveConfig(next)
              }}
            >
              <option value="both">両方</option>
              <option value="inner_only">Inner Capsule のみ</option>
              <option value="drag_only">Drag Shield のみ</option>
            </select>
          </label>
        </div>

        <div className="command-bar__group">
          <button type="button" className="button" onClick={() => setViewport(null)} disabled={!hasDatasets}>
            全体表示
          </button>
          <button
            type="button"
            className="button"
            disabled={!hasDatasets}
            onClick={() => {
              const span = effectiveViewport.max - effectiveViewport.min
              const centre = (effectiveViewport.max + effectiveViewport.min) / 2
              setViewport({ min: centre - span / 4, max: centre + span / 4 })
            }}
          >
            拡大
          </button>
          <button
            type="button"
            className="button"
            disabled={!hasDatasets}
            onClick={() => {
              const span = effectiveViewport.max - effectiveViewport.min
              const centre = (effectiveViewport.max + effectiveViewport.min) / 2
              setViewport({
                min: Math.max(bounds.min, centre - span),
                max: Math.min(bounds.max, centre + span),
              })
            }}
          >
            縮小
          </button>
        </div>

        <div className="command-bar__spacer" />

        <div className="command-bar__group">
          <button type="button" className="button" disabled={active === null} onClick={() => void doExport('xlsx')}>
            Excelで書き出す
          </button>
          <button type="button" className="button" disabled={active === null} onClick={() => void doExport('csv')}>
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
          <button type="button" className="button button--flat" onClick={() => setSettingsOpen(true)}>
            設定
          </button>
        </div>
      </header>

      <div className={hasDatasets ? 'workspace' : 'workspace workspace--single'}>
        <main className="graph-area">
          {notices.length === 0 ? null : (
            <div>
              {notices.map((notice) => (
                <div className={`notice notice--${notice.tone}`} key={notice.id} role="status">
                  <span className="notice__body">{notice.text}</span>
                  <button
                    type="button"
                    className="button button--flat"
                    onClick={() => dismissNotice(notice.id)}
                  >
                    閉じる
                  </button>
                </div>
              ))}
            </div>
          )}

          {statuses.analysis.kind === 'running' ? (
            <div className="progress" role="progressbar" aria-valuenow={statuses.analysis.percent}>
              <div className="progress__bar" style={{ width: `${statuses.analysis.percent}%` }} />
            </div>
          ) : null}

          {hasDatasets ? (
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
          ) : (
            <FileDropZone onFiles={(files) => void openFiles(files)} disabled={false} />
          )}
        </main>

        {hasDatasets ? (
          <aside className="side-panel">
            <section className="panel" aria-label="データセット">
              <div className="panel__header">
                <h2 className="panel__title">データセット</h2>
                <span className="panel__hint">{datasets.length} 件</span>
              </div>
              <ul className="dataset-list">
                {datasets.map((dataset) => (
                  <li key={dataset.name}>
                    <button
                      type="button"
                      className="dataset-list__item"
                      aria-current={dataset.name === activeName}
                      onClick={() => {
                        setActiveName(dataset.name)
                        setSelection(null)
                        setViewport(null)
                      }}
                    >
                      <span className="dataset-list__name">{dataset.name}</span>
                      <span className="panel__hint">{dataset.fromCache ? 'キャッシュ' : ''}</span>
                      <span
                        className="button button--flat"
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeDataset(dataset)
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return
                          event.stopPropagation()
                          closeDataset(dataset)
                        }}
                      >
                        閉じる
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <StatisticsPanel datasets={isComparing(mode) ? datasets : active === null ? [] : [active]} mode={mode} />

            <RangeStatisticsPanel
              selection={selection}
              result={rangeResult}
              enabled={selectionEnabled}
              onChange={setSelection}
            />

            <section className="panel" aria-label="ファイル情報">
              <div className="panel__header">
                <h2 className="panel__title">ファイル情報</h2>
              </div>
              {active === null ? (
                <p className="panel__hint">データセットを選択してください。</p>
              ) : (
                <dl className="data-table">
                  <div>
                    <dt>文字コード</dt>
                    <dd>{active.encoding}</dd>
                  </div>
                  <div>
                    <dt>行数</dt>
                    <dd>{active.sampleCount.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>時間列</dt>
                    <dd>{active.mapping.timeColumn}</dd>
                  </div>
                </dl>
              )}
              <button
                type="button"
                className="button"
                disabled={active === null}
                onClick={() => {
                  if (active === null) return
                  setPendingColumns({
                    source: {
                      sourceSha256: active.sourceSha256,
                      filename: active.filename,
                      encoding: active.encoding,
                      columnNames: [...active.columnNames],
                      detected: { time: [], acceleration: [] },
                      rowCount: active.sampleCount,
                      suggestedMapping: active.mapping,
                      ambiguity: null,
                    },
                    initial: active.mapping,
                    reason: undefined,
                  })
                }}
              >
                列を選び直す
              </button>
            </section>
          </aside>
        ) : null}
      </div>

      <CloudStatusBar statuses={statuses} onRetrySync={retrySync} onRetryPoster={retryPoster} />

      {pendingColumns === null ? null : (
        <ColumnSelectorDialog
          source={pendingColumns.source}
          initial={pendingColumns.initial}
          reason={pendingColumns.reason}
          onCancel={() => setPendingColumns(null)}
          onConfirm={(mapping) => {
            const source = pendingColumns.source
            setPendingColumns(null)
            void runAnalysis(source, mapping)
          }}
        />
      )}

      {settingsOpen ? (
        <SettingsDialog
          config={config}
          onCancel={() => setSettingsOpen(false)}
          onApply={(next) => {
            setConfig(next)
            if (!saveConfig(next)) {
              notify('warning', '設定をブラウザに保存できませんでした。今回のセッションのみ有効です。')
            }
            setSettingsOpen(false)
          }}
          onClearCache={() => {
            void clearCache().then(() => notify('info', 'ローカルキャッシュを削除しました。'))
          }}
        />
      ) : null}
    </div>
  )
}
