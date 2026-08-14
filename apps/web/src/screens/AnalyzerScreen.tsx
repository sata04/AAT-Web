/**
 * The analyzer: the screen AAT Web exists for.
 *
 * Holds the working state — open datasets, the view mode, the selection, the
 * viewport, the three cloud statuses — and wires the pieces together. It owns no
 * arithmetic: the numbers come from the analysis worker, the plot content from
 * `plot-model.ts`, the selection maths from `selection.ts`. That separation is
 * what keeps the interesting logic testable without a DOM, which matters here
 * because jsdom is deliberately not a dependency.
 *
 * This was `App.tsx` until routing arrived. The move is a move: the state, the
 * callbacks and the markup are the same, and the only substantive change is that
 * "am I signed in" now comes from the shared session provider instead of a local
 * boolean fed by a probe this component fired itself. That matters because the
 * rule it guards has not changed — the local analysis is complete and usable
 * before any cloud call is made, and `if (signedIn) void syncToCloud(dataset)`
 * is the last line of the success path for exactly that reason. Signed out,
 * offline, or deployed with no Worker at all, everything above that line still
 * runs.
 */

import type { AnalysisConfig } from '@aat/shared'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnalysisClient, type AnalysisProgress, AnalysisWorkerError } from '../analysis/client.ts'
import { defaultDialogMapping } from '../analysis/mapping.ts'
import type { ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import { type Dataset, datasetFromPayload, sensorModeFrom } from '../app/dataset.ts'
import { rangeStatisticsFor } from '../app/range-statistics.ts'
import { loadConfig } from '../app/settings.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import { type CloudStatuses, INITIAL_STATUSES, type PosterStatus } from '../cloud/status.ts'
import { syncDataset } from '../cloud/sync.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import { ExportClient, ExportTooLargeForWorksheet, saveBlob } from '../exporting/client.ts'
import { workbookInputFor } from '../exporting/input.ts'
import { canvasToPng, PNG_PARITY_NOTICE } from '../exporting/png.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import { buildPlotModel, modelDataRange } from '../graph/plot-model.ts'
import type { SelectionRange } from '../graph/selection.ts'
import { graphPalette, prefersDarkScheme, resolveTheme, themeSettingFrom } from '../graph/theme.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import { canSelectRange, transition, type ViewMode } from '../graph/view-mode.ts'
import { generateAutoPoster, type PosterContext, retryAutoPoster } from '../poster/requests.ts'
import { useSession } from '../session/SessionProvider.tsx'
import { AnalyzerView, type PendingColumnChoice } from './AnalyzerView.tsx'

/** How many notices stay on screen at once; older ones drop off. */
const MAX_NOTICES = 6

export function AnalyzerScreen(): React.JSX.Element {
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
  const [notices, setNotices] = useState<NoticeItem[]>([])
  // The revision the poster figures of the last synced dataset hang from. Null
  // until an analysis has been stored, which is most of the time: local-first.
  const [syncedPoster, setSyncedPoster] = useState<PosterContext | null>(null)
  const [customPosters, setCustomPosters] = useState<PosterFigure[]>([])

  // One probe for the whole application, in the provider. A negative answer is
  // the normal, fully functional local-only mode.
  const sessionStatus = useSession().status
  const signedIn = sessionStatus === 'signed-in'

  const analysisClient = useRef<AnalysisClient | null>(null)
  const exportClient = useRef<ExportClient | null>(null)
  const noticeId = useRef(0)
  // Aborts the poster poll when the screen goes away or a newer request starts.
  // Polling is a read loop against the poster listing; abandoning one costs the
  // renderer nothing, which is the point of not queueing work server-side.
  const posterPoll = useRef<AbortController | null>(null)

  // Lazily constructed so that merely loading the page does not start a worker,
  // and stable so the callbacks that use them do not change identity per render.
  const getAnalysisClient = useCallback(() => {
    analysisClient.current ??= new AnalysisClient()
    return analysisClient.current
  }, [])
  const getExportClient = useCallback(() => {
    exportClient.current ??= new ExportClient()
    return exportClient.current
  }, [])

  useEffect(
    () => () => {
      analysisClient.current?.dispose()
      exportClient.current?.dispose()
      posterPoll.current?.abort()
    },
    [],
  )

  const notify = useCallback((tone: NoticeItem['tone'], text: string) => {
    noticeId.current += 1
    const id = noticeId.current
    // Capped: a disturbed recording can raise a warning per stage per sensor,
    // and a wall of notices buries the graph it is trying to qualify.
    setNotices((current) => [...current, { id, tone, text }].slice(-MAX_NOTICES))
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

  const setPosterStatus = useCallback((poster: PosterStatus) => {
    setStatuses((current) => ({ ...current, poster }))
  }, [])

  /**
   * Ask for the automatic poster.
   *
   * There is no client-side "have I already asked for this?" flag here on
   * purpose. The guarantee that a revision has at most one automatic poster is
   * the partial unique index `poster_figures_auto_unique` in D1, claimed by an
   * `INSERT ... ON CONFLICT DO NOTHING`; a repeat call reads the existing row
   * back and renders nothing. A second mechanism in the browser could only be
   * weaker — it loses to a reload, a second tab and another device — and having
   * two would make it unclear which one was actually holding the line.
   *
   * What the browser *is* responsible for is not calling this from anywhere a
   * rerender can reach: it is invoked from a completed cloud sync and from the
   * explicit retry control, and from nowhere else.
   */
  const startAutoPoster = useCallback(
    async (context: PosterContext, posterId: string | null) => {
      posterPoll.current?.abort()
      const controller = new AbortController()
      posterPoll.current = controller
      const outcome =
        posterId === null
          ? await generateAutoPoster(context, setPosterStatus, controller.signal)
          : await retryAutoPoster(context, posterId, setPosterStatus, controller.signal)
      if (!outcome.ok && outcome.kind === 'spec') {
        // The spec could not be built, so nothing was sent. Retrying identical
        // inputs would fail identically, which is why this one is not retryable.
        setPosterStatus({ kind: 'failed', message: outcome.advice.message, retryable: false })
      }
    },
    [setPosterStatus],
  )

  const syncToCloud = useCallback(
    async (dataset: Dataset) => {
      setStatuses((current) => ({ ...current, sync: { kind: 'saving' } }))
      const outcome = await syncDataset(dataset, config)
      if (!outcome.ok) {
        setStatuses((current) => ({
          ...current,
          sync: {
            kind: 'failed',
            message: outcome.message,
            // An unreachable cloud is always worth retrying — it is usually a
            // network that came back.
            retryable: outcome.kind === 'unavailable' || outcome.retryable,
          },
        }))
        return
      }
      const { revisionId, runCode } = outcome.value
      const context: PosterContext = { revisionId, runCode, dataset }
      setSyncedPoster(context)
      setStatuses((current) => ({
        ...current,
        sync: { kind: 'saved', revisionId, at: Date.now() },
        poster: { kind: 'queued' },
      }))

      // Poster generation is a separate lane on purpose: it can be slow, it can
      // fail, and neither outcome touches the analysis the user already has.
      await startAutoPoster(context, null)
    },
    [config, startAutoPoster],
  )

  // A poster belongs to one revision of one file, so the panel shows one only
  // while that file is the one on screen. Switching datasets does not clear the
  // stored context — coming back to the file brings its poster back with it.
  const posterContext = useMemo(() => {
    if (syncedPoster === null || active === null) return null
    return syncedPoster.dataset.name === active.name ? syncedPoster : null
  }, [syncedPoster, active])

  const posterUnavailableReason = useMemo(() => {
    if (posterContext !== null) return null
    if (sessionStatus === 'unavailable') {
      return 'この環境ではクラウド機能を利用できません。解析・グラフ・統計・書き出しはこのまま利用できます。'
    }
    if (sessionStatus === 'signed-out') {
      return 'サインインすると、解析結果を保存してデスクトップ版と同じ体裁のポスター図を作成できます。解析・グラフ・統計・書き出しはサインインなしで利用できます。'
    }
    // Signed in, but this dataset has not been stored yet. The panel's own
    // default sentence says so; there is nothing more specific to add.
    return null
  }, [posterContext, sessionStatus])

  const activeCustomPosters = useMemo(
    () =>
      posterContext === null
        ? []
        : customPosters.filter((poster) => poster.analysisRevisionId === posterContext.revisionId),
    [customPosters, posterContext],
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
        setDatasets((current) => [...current.filter((existing) => existing.name !== dataset.name), dataset])
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
    [config, signedIn, notify, syncToCloud, getAnalysisClient],
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
            const remaining = files.length - files.indexOf(file) - 1
            if (remaining > 0) {
              // The dialog is modal, so the rest of the batch cannot be analysed
              // behind it. Say so rather than dropping files silently.
              notify('info', `残り ${remaining} 件は列を選択したあとで開き直してください。`)
            }
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
    [runAnalysis, notify, getAnalysisClient],
  )

  const closeDataset = useCallback(
    (dataset: Dataset) => {
      setDatasets((current) => current.filter((existing) => existing.name !== dataset.name))
      setActiveName((current) => (current === dataset.name ? null : current))
      void getAnalysisClient().release(dataset.sourceSha256)
    },
    [getAnalysisClient],
  )

  const retrySync = () => {
    if (active === null) return
    void syncToCloud(active)
  }

  /**
   * Retry the automatic poster.
   *
   * A figure that has an id and reached `failed` goes through the retry
   * endpoint, which is conditional on it still being failed — so five presses
   * start one render. A figure with no id (the request itself was refused, or
   * the renderer shed load before a row existed) goes back through the
   * idempotent endpoint, which picks up the queued row.
   */
  const retryPoster = () => {
    if (syncedPoster === null) return
    const posterId = statuses.poster.kind === 'failed' ? (statuses.poster.posterId ?? null) : null
    void startAutoPoster(syncedPoster, posterId)
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
        notify('warning', `${error.message}\n「CSVで書き出す」を選ぶと、行数制限なしで保存できます。`)
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

  const addCustomPoster = (poster: PosterFigure) => {
    setCustomPosters((current) => [poster, ...current])
  }

  return (
    <AnalyzerView
      state={{
        config,
        datasets,
        active,
        activeName,
        mode,
        selection,
        rangeResult,
        selectionEnabled,
        statuses,
        notices,
        posterContext,
        posterUnavailableReason,
        activeCustomPosters,
        pendingColumns,
        settingsOpen,
      }}
      plot={{
        model: plotModel,
        palette,
        viewport: effectiveViewport,
        bounds,
        geometry,
        canvas,
      }}
      actions={{
        openFiles,
        applyModeEvent: applyEvent,
        startComparison,
        setConfig,
        setViewport,
        setGeometry,
        setCanvas,
        setSelection,
        setActiveName,
        closeDataset,
        exportData: doExport,
        exportPng: doPngExport,
        dismissNotice,
        retrySync,
        retryPoster,
        addCustomPoster,
        notify,
        setPendingColumns,
        runAnalysis,
        setSettingsOpen,
      }}
    />
  )
}
