/**
 * The analyzer: the screen AAT Web exists for.
 *
 * Holds the working state — open datasets, the view mode, the selection, the
 * viewport, the three cloud statuses — and wires the pieces together. It owns no
 * arithmetic: the numbers come from the analysis worker, the plot content from
 * `plot-model.ts`, the selection maths from `selection.ts`, and each lane of
 * bookkeeping lives in its own module — `analyzer-loop.ts` (open/analyse/
 * close), `analyzer-cloud.ts` (sync/poster), `analyzer-actions.ts` (the small
 * verbs). That separation is what keeps the interesting logic testable without
 * a DOM, which matters here because jsdom is deliberately not a dependency.
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { type Dataset, sensorModeFrom } from '../app/dataset.ts'
import {
  loadOnboarding,
  type OnboardingFlag,
  type OnboardingState,
  saveOnboarding,
} from '../app/onboarding.ts'
import { type RangeStatisticsResult, rangeResultFor } from '../app/range-statistics.ts'
import { loadConfig } from '../app/settings.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import { type CloudStatuses, INITIAL_STATUSES } from '../cloud/status.ts'
import { useNotices } from '../components/hooks.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import {
  buildPlotModel,
  defaultViewportFor,
  graphBoundsFor,
  modelDataRange,
  type PlotModel,
} from '../graph/plot-model.ts'
import type { SelectionRange } from '../graph/selection.ts'
import { type GraphPalette, themeSettingFrom } from '../graph/theme.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import { useThemePalette } from '../graph/use-theme-palette.ts'
import { canSelectRange, isComparing, type ViewMode } from '../graph/view-mode.ts'
import type { PosterContext } from '../poster/requests.ts'
import { type SessionStatus, useSession } from '../session/SessionProvider.tsx'
import { type AnalyzerHint, AnalyzerView } from './AnalyzerView.tsx'
import { analyzerActions, useAnalysisClients } from './analyzer-actions.ts'
import {
  activePostersFor,
  posterContextFor,
  posterUnavailableReasonFor,
  useCloudSync,
} from './analyzer-cloud.ts'
import { useAnalyzerLoop } from './analyzer-loop.ts'

/** What the working state means once derived: the model, the viewport, the range stats, the poster context. */
interface AnalyzerDerived {
  active: Dataset | null
  plotModel: PlotModel
  effectiveViewport: ChartViewport
  bounds: ChartViewport
  selectionEnabled: boolean
  rangeResult: RangeStatisticsResult | null
  posterContext: PosterContext | null
  posterUnavailableReason: string | null
  activeCustomPosters: readonly PosterFigure[]
}

function useAnalyzerDerived(input: {
  datasets: readonly Dataset[]
  activeName: string | null
  mode: ViewMode
  config: AnalysisConfig
  palette: GraphPalette
  viewport: ChartViewport | null
  selection: SelectionRange | null
  syncedPoster: PosterContext | null
  customPosters: readonly PosterFigure[]
  sessionStatus: SessionStatus
}): AnalyzerDerived {
  const {
    datasets,
    activeName,
    mode,
    config,
    palette,
    viewport,
    selection,
    syncedPoster,
    customPosters,
    sessionStatus,
  } = input

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
  const defaultViewport = useMemo(
    (): ChartViewport => defaultViewportFor(plotModel, dataRange, config.default_graph_duration),
    [plotModel, dataRange, config.default_graph_duration],
  )
  const bounds = useMemo(
    (): ChartViewport => graphBoundsFor(dataRange, defaultViewport),
    [dataRange, defaultViewport],
  )

  // `null` means "follow the mode's default framing". Switching dataset or mode
  // clears it, which is how the desktop re-frames the graph on both.
  const effectiveViewport = viewport ?? defaultViewport

  const selectionEnabled = canSelectRange(mode)
  const rangeResult = useMemo(
    () => rangeResultFor(active, selection, selectionEnabled),
    [active, selection, selectionEnabled],
  )

  const posterContext = useMemo(() => posterContextFor(syncedPoster, active), [syncedPoster, active])
  const posterUnavailableReason = useMemo(
    () => posterUnavailableReasonFor(posterContext, sessionStatus),
    [posterContext, sessionStatus],
  )
  const activeCustomPosters = useMemo(
    () => activePostersFor(customPosters, posterContext),
    [customPosters, posterContext],
  )

  return {
    active,
    plotModel,
    effectiveViewport,
    bounds,
    selectionEnabled,
    rangeResult,
    posterContext,
    posterUnavailableReason,
    activeCustomPosters,
  }
}

export function AnalyzerScreen(): React.JSX.Element {
  const [config, setConfig] = useState<AnalysisConfig>(loadConfig)
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)
  const [mode, setMode] = useState<ViewMode>('NORMAL')
  const [selection, setSelection] = useState<SelectionRange | null>(null)
  const [viewport, setViewport] = useState<ChartViewport | null>(null)
  const [geometry, setGeometry] = useState<ChartGeometry | null>(null)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [gestureLayer, setGestureLayer] = useState<HTMLElement | null>(null)
  const [statuses, setStatuses] = useState<CloudStatuses>(INITIAL_STATUSES)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [customPosters, setCustomPosters] = useState<PosterFigure[]>([])
  const [onboarding, setOnboarding] = useState<OnboardingState>(loadOnboarding)
  const [welcomeOpen, setWelcomeOpen] = useState(() => !loadOnboarding().welcomeSeen)
  const [helpOpen, setHelpOpen] = useState(false)

  const markOnboarding = useCallback((flag: OnboardingFlag) => {
    setOnboarding((current) => {
      if (current[flag]) return current
      const next = { ...current, [flag]: true }
      saveOnboarding(next)
      return next
    })
  }, [])

  // A file opened while the welcome is still up answers the welcome's
  // question — close it and count it as seen rather than leaving a modal over
  // fresh data.
  useEffect(() => {
    if (welcomeOpen && datasets.length > 0) {
      setWelcomeOpen(false)
      markOnboarding('welcomeSeen')
    }
  }, [welcomeOpen, datasets.length, markOnboarding])

  // Doing the thing is the same as being taught it: a user who selects a
  // range or enters compare before the hint appears never needs to see it.
  useEffect(() => {
    if (selection !== null) markOnboarding('rangeHintSeen')
  }, [selection, markOnboarding])
  useEffect(() => {
    if (isComparing(mode)) markOnboarding('compareHintSeen')
  }, [mode, markOnboarding])

  // One probe for the whole application, in the provider. A negative answer is
  // the normal, fully functional local-only mode.
  const sessionStatus = useSession().status
  const signedIn = sessionStatus === 'signed-in'

  const { analysisClient, getAnalysisClient, getExportClient } = useAnalysisClients()
  const { notices, notify, dismissNotice, dismissAllNotices } = useNotices(6)
  const { theme, palette } = useThemePalette(themeSettingFrom(config.theme))
  const { cloudSubject, syncedPoster, syncToCloud, startAutoPoster } = useCloudSync(setStatuses)
  const loop = useAnalyzerLoop({
    getAnalysisClient,
    analysisClient,
    config,
    signedIn,
    datasets,
    activeName,
    cloudSubject,
    notify,
    syncToCloud,
    setStatuses,
    setDatasets,
    setActiveName,
    setSelection,
    setViewport,
    setConfig,
    setSettingsOpen,
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const derived = useAnalyzerDerived({
    datasets,
    activeName,
    mode,
    config,
    palette,
    viewport,
    selection,
    syncedPoster,
    customPosters,
    sessionStatus,
  })

  const analysisReady = statuses.analysis.kind === 'ready'

  // One hint at a time, in the order a new user meets the features: how the
  // graph gestures work, then what comparing is for, then what dragging
  // selects for. None of them shows while a modal is up or before an analysis
  // exists to point at.
  const hint: AnalyzerHint | null = (() => {
    if (welcomeOpen || helpOpen || !analysisReady) return null
    if (!onboarding.graphHintSeen) return 'graph'
    if (datasets.length >= 2 && !onboarding.compareHintSeen) return 'compare'
    if (derived.selectionEnabled && selection === null && !onboarding.rangeHintSeen) return 'range'
    return null
  })()

  const actions = analyzerActions({
    loop,
    datasets,
    active: derived.active,
    mode,
    rangeResult: derived.rangeResult,
    canvas,
    palette,
    cloudSubject,
    statuses,
    syncedPoster,
    notify,
    dismissNotice,
    getExportClient,
    syncToCloud,
    startAutoPoster,
    setMode,
    setSelection,
    setViewport,
    setGeometry,
    setCanvas,
    setGestureLayer,
    setActiveName,
    setConfig,
    setSettingsOpen,
    setCustomPosters,
    setStatuses,
  })

  const dismissHint = (seen: AnalyzerHint) => {
    const flag = ({ graph: 'graphHintSeen', range: 'rangeHintSeen', compare: 'compareHintSeen' } as const)[
      seen
    ]
    markOnboarding(flag)
  }

  const onboardingActions = {
    dismissWelcome: () => {
      setWelcomeOpen(false)
      markOnboarding('welcomeSeen')
    },
    openHelp: () => {
      // Reaching help through the welcome is a dismissal of the welcome.
      if (welcomeOpen) markOnboarding('welcomeSeen')
      setWelcomeOpen(false)
      setHelpOpen(true)
    },
    closeHelp: () => setHelpOpen(false),
    reopenWelcome: () => {
      setHelpOpen(false)
      setWelcomeOpen(true)
    },
    dismissHint,
  }

  return (
    <AnalyzerView
      state={{
        config,
        datasets,
        active: derived.active,
        activeName,
        mode,
        selection,
        rangeResult: derived.rangeResult,
        selectionEnabled: derived.selectionEnabled,
        statuses,
        // The cloud lanes describe the last file synced, which is not always
        // the one on screen — the status bar names it when they differ.
        cloudSubject,
        notices,
        posterContext: derived.posterContext,
        posterUnavailableReason: derived.posterUnavailableReason,
        activeCustomPosters: derived.activeCustomPosters,
        pendingColumns: loop.pendingColumns,
        settingsOpen,
        welcomeOpen,
        helpOpen,
        hint,
      }}
      plot={{
        model: derived.plotModel,
        palette,
        viewport: derived.effectiveViewport,
        bounds: derived.bounds,
        geometry,
        canvas,
        gestureLayer,
      }}
      actions={{ ...actions, ...onboardingActions, dismissAllNotices }}
    />
  )
}
