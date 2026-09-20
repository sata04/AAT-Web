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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useTopmostDialogKeys } from '../components/Dialog.tsx'
import { applyViewEvent, useNotices } from '../components/hooks.ts'
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
import {
  canSelectRange,
  isComparing,
  isGQuality,
  isShowingAll,
  leaveComparing,
  transition,
  type ViewMode,
} from '../graph/view-mode.ts'
import { type DemoDataset, demoCsvFile, demoFilename } from '../onboarding/demo-data.ts'
import { type TourDriver, type TourSnapshot, type TourView, tourViewOf } from '../onboarding/tour-driver.ts'
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
  /** The plotted data's x extent — the tour's driver reads it to place selections. */
  dataRange: { min: number; max: number } | null
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
    dataRange,
  }
}

/**
 * The tour is the only consumer of this module — a first-run-only surface —
 * so it stays a lazy chunk: returning researchers never pay the download for
 * code that by design never runs for them.
 */
const OnboardingStage = lazy(() => import('../onboarding/OnboardingStage.tsx'))

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
  // The first-run tour — the flag it consumes is still `welcomeSeen`, so the
  // returning researcher who answered the old welcome is not re-greeted by its
  // replacement, and e2e's seeded fixtures keep meaning "already onboarded".
  const [tourOpen, setTourOpen] = useState(() => !loadOnboarding().welcomeSeen)
  const [helpOpen, setHelpOpen] = useState(false)

  const markOnboarding = useCallback((flag: OnboardingFlag) => {
    setOnboarding((current) => {
      if (current[flag]) return current
      const next = { ...current, [flag]: true }
      saveOnboarding(next)
      return next
    })
  }, [])

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
  // exists to point at. The graph hint also waits for normal mode — its lead
  // claim is that dragging selects a range, which other modes turn off.
  const hint: AnalyzerHint | null = (() => {
    if (tourOpen || helpOpen || !analysisReady || datasets.length === 0) return null
    if (!onboarding.graphHintSeen && derived.selectionEnabled) return 'graph'
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

  // The state the tour's driver reads — a live ref so a scene mid-wait always
  // sees the latest commit, not the render it was built under.
  const tourSnapshotRef = useRef<TourSnapshot>({
    datasets,
    mode,
    activeName,
    selection,
    viewport,
    analysisReady,
    dataRange: null,
    geometry: null,
    gestureLayer: null,
  })
  useEffect(() => {
    tourSnapshotRef.current = {
      datasets,
      mode,
      activeName,
      selection,
      viewport,
      analysisReady,
      dataRange: derived.dataRange,
      geometry,
      gestureLayer,
    }
    // Reconcile tour installs at the commit boundary — the only place that
    // observes every datasets array. `openDemo` cannot adopt inside its own
    // continuation: `loop.openFiles` resolves before this commit lands, so a
    // same-tick read would miss the install entirely.
    const tracker = tourOwnedRef.current
    for (const [filename, pending] of tracker.pending) {
      const installed = datasets.find((dataset) => dataset.filename === filename)
      if (installed !== undefined && !tracker.reconciled.has(installed)) {
        // Whatever object is visible for this name belongs to the newest
        // request: a restart mid-open re-picks the filename, and React may
        // batch two installs into one commit — per-object bookkeeping would
        // either misattribute or orphan the survivor.
        tracker.reconciled.add(installed)
        tracker.owned.set(pending.latest.which, installed)
        if (pending.latest.epoch !== tracker.epoch || !tracker.keep.has(pending.latest.which)) {
          tracker.closing.add(installed)
          loop.closeDataset(installed)
        }
      }
      if (pending.inFlight === 0) {
        // Settle runs after the install dispatched, so once every open has
        // resolved whatever is committed now is all that is ever coming —
        // an open dropped into `closedSources` produced nothing to wait for.
        tracker.pending.delete(filename)
      }
    }
  })

  // Which datasets this run installed, role → filename it landed under; which
  // opens are still in flight; and the epoch a stale open checks before it
  // stays. In a ref because `loop` is recreated every commit — `useMemo`
  // state tied to it would reset each render.
  const tourOwnedRef = useRef({
    // The installed Dataset objects — identity, not filename: a researcher who
    // closes a kept demo and reopens their own file under the same name gets a
    // different object, which cleanup therefore never matches.
    owned: new Map<DemoDataset, Dataset>(),
    keep: new Set<DemoDataset>(),
    // In-flight opens per chosen filename: how many are still resolving, and
    // the newest request — whose epoch and role the visible install obeys.
    pending: new Map<string, { inFlight: number; latest: { which: DemoDataset; epoch: number } }>(),
    // Installs already matched to a request — the same dataset object still
    // visible on the next commit must not consume another open.
    reconciled: new WeakSet<Dataset>(),
    // Demo datasets the tour has closed but whose removal has not committed
    // yet. `snapshot` is a commit-boundary read, so a scene that closes and
    // re-opens in one tick — stepping back into `compare` does exactly that —
    // would otherwise read its own outgoing dataset as a name collision and
    // install the sample under the fallback name meant for a researcher's file.
    closing: new WeakSet<Dataset>(),
    epoch: 0,
  })

  // What the workspace looked like when the stage opened — a skipped replay
  // restores this, so driving a researcher's session gives the view back.
  // Captured on the open commit: scenes have not run yet (the intro is
  // pinned), so this is always the pre-tour state.
  const tourBaselineRef = useRef<TourView | null>(null)
  useEffect(() => {
    tourBaselineRef.current = tourOpen ? tourViewOf(tourSnapshotRef.current) : null
  }, [tourOpen])

  const tourDriver = useMemo<TourDriver>(() => {
    // Datasets this run opened, by role → the filename they landed under.
    // Ownership is recorded at install: a researcher's file with a colliding
    // name is never mistaken for the demo, and `discardPending` bumps the
    // epoch so an open still in flight when the stage exits self-closes the
    // moment it installs instead of appearing on a pristine workspace.
    // `tracker` lives in a ref, not this memo's closure: `loop` is a new
    // object every commit, so maps captured here would be silently discarded
    // on every render — and cleanup would iterate an empty `owned`.
    const tracker = tourOwnedRef.current
    const snapshot = tourSnapshotRef
    return {
      snapshot: () => snapshot.current,
      openFiles: (files) => loop.openFiles(files),
      openDemo: async (which) => {
        // Only a still-present owned object exempts its name — a stale entry
        // (user closed the demo, reused the filename) must not hide the
        // researcher's current dataset from `taken`.
        const mine = new Set(
          [...tracker.owned.values()]
            .filter((dataset) => snapshot.current.datasets.includes(dataset))
            .map((dataset) => dataset.name),
        )
        const taken = new Set(
          snapshot.current.datasets
            .filter((dataset) => !mine.has(dataset.name) && !tracker.closing.has(dataset))
            .map((dataset) => dataset.name),
        )
        const filename = demoFilename(which, taken)
        tracker.keep.add(which)
        // Adoption happens in the snapshot-sync effect — the commit boundary —
        // because `openFiles` resolves before the install commits.
        const record = tracker.pending.get(filename) ?? {
          inFlight: 0,
          latest: { which, epoch: tracker.epoch },
        }
        record.inFlight += 1
        record.latest = { which, epoch: tracker.epoch }
        tracker.pending.set(filename, record)
        try {
          // Local-only: the tour's own copy promises nothing leaves the
          // browser, and a skipped tour must never leave cloud revisions or
          // poster jobs behind for a signed-in researcher.
          await loop.openFiles([demoCsvFile(which, filename)], { localOnly: true })
        } finally {
          record.inFlight -= 1
        }
        return filename
      },
      closeTourDatasets: (except = []) => {
        tracker.keep.clear()
        for (const which of except) tracker.keep.add(which)
        for (const [which, dataset] of tracker.owned) {
          if (tracker.keep.has(which)) continue
          if (snapshot.current.datasets.includes(dataset)) {
            tracker.closing.add(dataset)
            loop.closeDataset(dataset)
          }
          tracker.owned.delete(which)
        }
      },
      discardPending: () => {
        tracker.epoch += 1
      },
      activateDemo: (which) => {
        const dataset = tracker.owned.get(which)
        if (dataset === undefined || !snapshot.current.datasets.includes(dataset)) return
        setActiveName(dataset.name)
        setSelection(null)
        setViewport(null)
      },
      applyModeEvent: (event) =>
        applyViewEvent(snapshot.current.mode, event, { setMode, setSelection, setViewport }),
      setNormalMode: () => {
        // Fold the overlay transitions locally — committing each one would let
        // the next read the pre-commit mode and transition from it again.
        let next = snapshot.current.mode
        if (isComparing(next)) next = leaveComparing(next)
        if (isShowingAll(next)) next = transition(next, 'SHOW_ALL_OFF')
        else if (isGQuality(next)) next = transition(next, 'G_QUALITY_OFF')
        setMode(next)
        setSelection(null)
        setViewport(null)
      },
      setSelection,
      setViewport,
      restoreBaseline: () => {
        const baseline = tourBaselineRef.current
        const remaining = snapshot.current.datasets
        const active =
          baseline !== null &&
          baseline.activeName !== null &&
          remaining.some((dataset) => dataset.name === baseline.activeName)
            ? baseline.activeName
            : (remaining[0]?.name ?? null)
        setMode(baseline?.mode ?? 'NORMAL')
        setActiveName(active)
        setSelection(baseline?.selection ?? null)
        setViewport(baseline?.viewport ?? null)
      },
      openFilePicker: () => document.getElementById('aat-file-open')?.click(),
    }
  }, [loop])

  const finishTour = useCallback(
    (kind: 'keep' | 'skip', drove: boolean) => {
      if (kind === 'skip' && drove) {
        // Mid-tour exits leave the workspace pristine: kill pending demo
        // opens, close what the scenes installed, and hand the view back as
        // the stage found it.
        tourDriver.discardPending()
        tourDriver.closeTourDatasets()
        tourDriver.restoreBaseline()
      }
      if (kind === 'keep' && drove) {
        // The tour already demonstrated selection, gestures and compare live;
        // replaying those as hint bars the moment it ends would be noise.
        markOnboarding('graphHintSeen')
        markOnboarding('rangeHintSeen')
        markOnboarding('compareHintSeen')
      }
      // The run is over: whatever it left is now the researcher's own data.
      // Forget ownership — a replay must see kept demos in `taken` (and pick
      // fallback names), never as objects it is allowed to close. A skipped
      // run keeps `pending` alive until settle so an open still in flight
      // self-closes on install; a kept run drops it — the landing file is
      // exactly what the user asked for.
      const tracker = tourOwnedRef.current
      tracker.owned.clear()
      tracker.keep.clear()
      if (kind === 'keep') tracker.pending.clear()
      markOnboarding('welcomeSeen')
      setTourOpen(false)
    },
    [tourDriver, markOnboarding],
  )

  const onboardingActions = {
    openHelp: () => setHelpOpen(true),
    closeHelp: () => setHelpOpen(false),
    reopenTour: () => {
      setHelpOpen(false)
      setTourOpen(true)
    },
    dismissHint,
  }

  return (
    <>
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
      {tourOpen ? (
        <Suspense fallback={<TourLoadingScrim onSkip={() => finishTour('skip', false)} />}>
          <OnboardingStage driver={tourDriver} onFinish={finishTour} />
        </Suspense>
      ) : null}
    </>
  )
}

/**
 * What `tourOpen` shows while the stage chunk downloads: an inert scrim on
 * the same layer the stage will occupy. Without it the bare analyzer stays
 * interactive through the fetch — a started import or opened dialog would
 * land *under* a modal that mounts seconds later.
 */
function TourLoadingScrim(props: { onSkip: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  // Registers in the topmost-panel set, and Escape skips the tour just as the
  // loaded stage's would — dismissal must not depend on chunk timing. The
  // scrim holds no tabbable child; the shared trap now owns Tab even then.
  useTopmostDialogKeys(ref, props.onSkip)
  useEffect(() => {
    // Same focus contract as Dialog: remember what had focus, and hand it
    // back on unmount — whether the unmount is a skip or the loaded stage
    // replacing the scrim (the stage then captures the restored element).
    const previous = document.activeElement
    ref.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="AAT Web のはじめてガイド"
      aria-busy="true"
    />
  )
}
