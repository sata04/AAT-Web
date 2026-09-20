/**
 * The analyzer's open/analyse lane: how a dropped `File` becomes a `Dataset`,
 * how a settings edit re-runs every open dataset, and how closing a dataset
 * releases what it held. `AnalyzerScreen` wires this hook to the view; the
 * functions here take an explicit `deps` bag so the wiring is all that stays
 * in the component.
 */

import { type AnalysisConfig, configHash } from '@aat/shared'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AnalysisClient, type AnalysisProgress, AnalysisWorkerError } from '../analysis/client.ts'
import { defaultDialogMapping } from '../analysis/mapping.ts'
import type { ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import { type Dataset, datasetFromPayload, openedSourceForDataset } from '../app/dataset.ts'
import { saveConfig } from '../app/settings.ts'
import type { CloudStatuses } from '../cloud/status.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { PendingColumnChoice } from './AnalyzerView.tsx'

/**
 * Everything the open/analyse lane touches, handed in as one object so the
 * callables below read like the component body they were lifted from.
 */
export interface AnalyzerLoopDeps {
  /** Builds the worker client on first use; page load alone must not start one. */
  getAnalysisClient: () => AnalysisClient
  /** The live client ref — read by paths that only cancel, which must not construct one. */
  analysisClient: { current: AnalysisClient | null }
  config: AnalysisConfig
  signedIn: boolean
  datasets: readonly Dataset[]
  activeName: string | null
  /** Which file the cloud lanes are describing; a closed subject's failure is stale. */
  cloudSubject: string | null
  pendingColumns: PendingColumnChoice | null
  notify: (tone: NoticeItem['tone'], text: string) => void
  syncToCloud: (dataset: Dataset, analysedWith?: AnalysisConfig) => Promise<void>
  setStatuses: Dispatch<SetStateAction<CloudStatuses>>
  setDatasets: Dispatch<SetStateAction<Dataset[]>>
  setActiveName: Dispatch<SetStateAction<string | null>>
  setSelection: Dispatch<SetStateAction<SelectionRange | null>>
  setViewport: Dispatch<SetStateAction<ChartViewport | null>>
  setConfig: Dispatch<SetStateAction<AnalysisConfig>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setPendingColumns: Dispatch<SetStateAction<PendingColumnChoice | null>>
  /**
   * The `File` each open dataset came from, keyed by source SHA-256. A `File`
   * is a disk reference — holding it costs no memory — and it is the only way
   * to recover when the worker's bounded table cache has evicted a parsed CSV
   * that needs re-analysing.
   */
  sourceFiles: { current: Map<string, File> }
  /**
   * Datasets the user closed while a worker request was still in flight,
   * keyed by filename. Filename, not hash: two datasets from identical bytes
   * share a `sourceSha256`, and one closing must not make the other's results
   * droppable.
   */
  closedSources: { current: Set<string> }
  /**
   * Files waiting behind the modal column dialog, in drop order. The dialog
   * can only ask about one source at a time, so the rest of the batch parks
   * here and resumes on resolve — including on cancel, which skips the
   * ambiguous file, not the batch.
   */
  pendingFileQueue: { current: File[] }
  /** Bumped on every cancel; an open/analyse loop reads it to stop cleanly. */
  cancelEpoch: { current: number }
  /** The dataset list as of the last commit — re-analysis loops read it mid-flight. */
  datasetsRef: { current: readonly Dataset[] }
}

/** Everything `runAnalysisFor` needs to describe one request. */
interface AnalysisJob {
  source: OpenedSource
  mapping: ColumnMapping
  configOverride?: AnalysisConfig | undefined
  /** Set when this attempt is already a re-open, so it cannot recurse. */
  reopenedOnce?: boolean | undefined
  /**
   * The cancellation epoch the caller captured. Absent, the current epoch is
   * used — the caller is the request's own epoch authority by definition.
   */
  epoch?: number | undefined
}

/** A completed request ready to install, plus the context it ran under. */
interface InstalledAnalysis {
  source: OpenedSource
  result: Awaited<ReturnType<AnalysisClient['analyse']>>
  effectiveConfig: AnalysisConfig
  epoch: number
}

/**
 * Install a finished analysis.
 *
 * Two arrivals are dropped instead: one whose file the user closed while the
 * worker was computing, and one whose epoch went stale — a user cancel, or a
 * newer settings application whose own re-analysis supersedes it. Both still
 * release the retained table so it cannot linger.
 */
async function installAnalysisResult(
  deps: AnalyzerLoopDeps,
  client: AnalysisClient,
  installed: InstalledAnalysis,
): Promise<void> {
  const { source, result, effectiveConfig, epoch } = installed
  if (deps.closedSources.current.delete(source.filename)) {
    void client.release(source.sourceSha256).catch(() => {})
    return
  }
  const dataset = datasetFromPayload(result.payload, effectiveConfig, result.fromCache)
  if (epoch !== deps.cancelEpoch.current) {
    void client.release(source.sourceSha256).catch(() => {})
    return
  }
  deps.setDatasets((current) => {
    // Re-analysing or re-opening a file must not move it to the end of the
    // list — the comparison graph draws in list order.
    const index = current.findIndex((existing) => existing.name === dataset.name)
    if (index === -1) return [...current, dataset]
    const next = [...current]
    next[index] = dataset
    return next
  })
  deps.setActiveName(dataset.name)
  deps.setSelection(null)
  deps.setViewport(null)
  deps.setStatuses((current) => ({
    ...current,
    analysis: { kind: 'ready', fromCache: result.fromCache },
  }))

  for (const warning of dataset.warnings) {
    deps.notify('warning', `${dataset.name}: ${warning.message}`)
  }

  // The local analysis is finished and usable at this point. Everything below
  // is optional and must never gate it.
  if (deps.signedIn) void deps.syncToCloud(dataset)
}

/**
 * The worker's bounded table cache evicted this file. Its `File` is still
 * held, so re-open transparently and try once more instead of sending the
 * user back to the drop zone. False when no file is held or the re-open
 * failed, leaving the generic failure path to report it.
 */
async function reopenFromFile(
  deps: AnalyzerLoopDeps,
  client: AnalysisClient,
  job: AnalysisJob,
): Promise<boolean> {
  const file = deps.sourceFiles.current.get(job.source.sourceSha256)
  if (file === undefined) return false
  try {
    // The stored `File` supplies only bytes — equal hashes mean equal content,
    // so which file occupies the slot is immaterial. The name is not: two
    // datasets can share one hash entry, and the job's filename is the dataset
    // identity this analysis is for.
    const reopened = await client.open(job.source.filename, await file.arrayBuffer())
    await runAnalysisFor(deps, { ...job, source: reopened, reopenedOnce: true })
    return true
  } catch {
    return false
  }
}

/**
 * Missing columns reopen the column dialog rather than ending in a failure
 * lane — the desktop does the same, because a wrong guess would produce a
 * believable graph of the wrong column. True when this was the failure.
 */
function reportMissingColumns(deps: AnalyzerLoopDeps, error: unknown, job: AnalysisJob): boolean {
  if (!(error instanceof AnalysisWorkerError) || error.code !== 'COLUMN_NOT_FOUND') return false
  deps.setPendingColumns({
    source: job.source,
    initial: job.mapping,
    reason: `次の列が見つかりませんでした: ${error.missingColumns.join(', ')}\n使用する列を選び直してください。`,
  })
  deps.setStatuses((current) => ({ ...current, analysis: { kind: 'idle' } }))
  return true
}

/**
 * Only the live epoch gets to write the lane — a superseded loop must not
 * leave 'cancelled' over the status of the analysis that replaced it.
 */
function reportCancelled(deps: AnalyzerLoopDeps, epoch: number | undefined): void {
  if (epoch !== deps.cancelEpoch.current) return
  deps.setStatuses((current) => ({ ...current, analysis: { kind: 'cancelled' } }))
}

function reportFailure(deps: AnalyzerLoopDeps, filename: string, code: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  deps.setStatuses((current) => ({ ...current, analysis: { kind: 'failed', message, code } }))
  deps.notify('error', `${filename}: ${message}`)
}

async function reportAnalysisError(
  deps: AnalyzerLoopDeps,
  client: AnalysisClient,
  error: unknown,
  job: AnalysisJob,
): Promise<void> {
  const code = error instanceof AnalysisWorkerError ? error.code : 'INTERNAL'
  if (code === 'ANALYSIS_CANCELLED') {
    reportCancelled(deps, job.epoch)
    return
  }
  const canReopen = code === 'SOURCE_NOT_RETAINED' && !job.reopenedOnce
  if (canReopen && (await reopenFromFile(deps, client, job))) return
  if (reportMissingColumns(deps, error, job)) return
  reportFailure(deps, job.source.filename, code, error)
}

/**
 * Analyse an already-opened source.
 *
 * Results are stale the moment anything bumps the epoch — a user cancel, or a
 * newer settings application whose own re-analysis supersedes this one —
 * which is why the epoch defaults to the value captured at call time and why
 * `openFiles` passes its own instead of taking the default.
 */
export async function runAnalysisFor(deps: AnalyzerLoopDeps, job: AnalysisJob): Promise<void> {
  const { source, mapping, configOverride, epoch = deps.cancelEpoch.current } = job
  const client = deps.getAnalysisClient()
  const effectiveConfig = configOverride ?? deps.config
  const onProgress = (progress: AnalysisProgress) => {
    if (epoch !== deps.cancelEpoch.current) return
    deps.setStatuses((current) => ({
      ...current,
      analysis: { kind: 'running', stage: progress.stage, percent: progress.percent },
    }))
  }

  try {
    const result = await client.analyse(
      {
        sourceSha256: source.sourceSha256,
        filename: source.filename,
        config: effectiveConfig,
        mapping,
        skipGQuality: !effectiveConfig.auto_calculate_g_quality,
        useCache: effectiveConfig.use_cache,
      },
      onProgress,
    )
    await installAnalysisResult(deps, client, { source, result, effectiveConfig, epoch })
  } catch (error) {
    await reportAnalysisError(deps, client, error, { ...job, epoch })
  }
}

function reportOpenError(deps: AnalyzerLoopDeps, filename: string, error: unknown): 'cancelled' | 'failed' {
  const code = error instanceof AnalysisWorkerError ? error.code : 'INTERNAL'
  if (code === 'ANALYSIS_CANCELLED') {
    deps.setStatuses((current) => ({ ...current, analysis: { kind: 'cancelled' } }))
    return 'cancelled'
  }
  const message = error instanceof Error ? error.message : String(error)
  deps.setStatuses((current) => ({ ...current, analysis: { kind: 'failed', message, code } }))
  deps.notify('error', `${filename}: ${message}`)
  return 'failed'
}

/**
 * Open dropped files, asking about ambiguous columns via the modal dialog and
 * analysing the rest.
 *
 * The epoch is re-checked after *every* await inside the loop, not just
 * between files: a cancel that lands while `file.arrayBuffer()` or the open
 * request is in flight must stop this file too, or it would call
 * `runAnalysisFor` under a fresh epoch and install the very file the user
 * cancelled. The same epoch is handed to `runAnalysisFor` so the file cannot
 * slip in through the default-epoch door either.
 */
/**
 * One file of the batch. `stop` means a cancellation landed or a superseded
 * epoch did, and the whole batch is over; `columns` means the modal dialog
 * now owns the remaining queue.
 */
async function openSingleFile(
  deps: AnalyzerLoopDeps,
  client: AnalysisClient,
  file: File,
  epoch: number,
): Promise<'done' | 'columns' | 'stop'> {
  try {
    const bytes = await file.arrayBuffer()
    if (deps.cancelEpoch.current !== epoch) return 'stop'
    const source = await client.open(file.name, bytes, (progress) => {
      if (deps.cancelEpoch.current !== epoch) return
      deps.setStatuses((current) => ({
        ...current,
        analysis: { kind: 'running', stage: progress.stage, percent: progress.percent },
      }))
    })
    if (deps.cancelEpoch.current !== epoch) {
      // The open still landed — release the retained table rather than leave
      // it for a file the batch will never analyse.
      void client.release(source.sourceSha256).catch(() => {})
      return 'stop'
    }
    deps.sourceFiles.current.set(source.sourceSha256, file)
    // A re-open supersedes any close-while-in-flight marker.
    deps.closedSources.current.delete(source.filename)
    if (source.suggestedMapping === null) {
      // Ambiguous or missing candidates: ask, rather than guess. A wrong
      // guess does not fail — it produces a believable graph of the wrong
      // column, which is far worse.
      deps.setPendingColumns({
        source,
        initial: defaultDialogMapping(source.detected),
        reason: undefined,
      })
      deps.setStatuses((current) => ({ ...current, analysis: { kind: 'idle' } }))
      return 'columns'
    }
    await runAnalysisFor(deps, { source, mapping: source.suggestedMapping, epoch })
    return 'done'
  } catch (error) {
    return reportOpenError(deps, file.name, error) === 'cancelled' ? 'stop' : 'done'
  }
}

export async function openFilesFor(deps: AnalyzerLoopDeps, files: File[]): Promise<void> {
  const client = deps.getAnalysisClient()
  const epoch = deps.cancelEpoch.current
  for (let index = 0; index < files.length; index++) {
    if (deps.cancelEpoch.current !== epoch) break
    const file = files[index] as File
    deps.setStatuses((current) => ({
      ...current,
      analysis: { kind: 'running', stage: 'decoding', percent: 0 },
    }))
    const outcome = await openSingleFile(deps, client, file, epoch)
    if (outcome === 'stop') return
    if (outcome === 'columns') {
      // The dialog is modal; the rest of the batch resumes when it
      // resolves rather than requiring a second drop.
      deps.pendingFileQueue.current = files.slice(index + 1)
      return
    }
  }
}

/** What remains of a batch once the column dialog has spoken for this file. */
export function drainPendingFilesFor(deps: AnalyzerLoopDeps): void {
  const rest = deps.pendingFileQueue.current
  deps.pendingFileQueue.current = []
  if (rest.length > 0) void openFilesFor(deps, rest)
}

/**
 * Confirm the column choice: analyse this file, then continue the batch.
 *
 * The drain is gated on the epoch the dialog was answered under: a user cancel
 * resolves the analysis with ANALYSIS_CANCELLED, which is a normal return, so
 * without the gate a cancelled batch would open its next queued file anyway.
 */
export function confirmPendingColumnsFor(deps: AnalyzerLoopDeps, mapping: ColumnMapping): void {
  const choice = deps.pendingColumns
  deps.setPendingColumns(null)
  if (choice === null) return
  const epoch = deps.cancelEpoch.current
  void runAnalysisFor(deps, { source: choice.source, mapping, epoch }).finally(() => {
    if (deps.cancelEpoch.current === epoch) drainPendingFilesFor(deps)
  })
}

/** Cancel skips this file; the rest of the batch still deserves its answer. */
export function cancelPendingColumnsFor(deps: AnalyzerLoopDeps): void {
  deps.setPendingColumns(null)
  drainPendingFilesFor(deps)
}

/**
 * Abort whatever the worker is doing. `cancelPending` resolves every
 * in-flight request with `ANALYSIS_CANCELLED`, which the catch paths above
 * turn into the `cancelled` status rather than a failure.
 */
export function cancelAnalysisFor(deps: AnalyzerLoopDeps): void {
  deps.cancelEpoch.current += 1
  deps.analysisClient.current?.cancelPending()
  deps.setStatuses((current) =>
    current.analysis.kind === 'running' ? { ...current, analysis: { kind: 'cancelled' } } : current,
  )
}

/**
 * Re-analyse every open dataset under the new configuration.
 *
 * The bump-and-cancel happens only now that a numeric change is confirmed — a
 * theme edit must not abort an unrelated analysis. A previous settings loop
 * may still be running, and its results must never land on top of the ones
 * this edit is about to produce: each `runAnalysisFor` call carries this
 * epoch and refuses to install once it goes stale. The bump also aborts a
 * batch open still in progress — it was asked for under the old
 * configuration.
 */
async function reanalyseForConfig(
  deps: AnalyzerLoopDeps,
  previous: AnalysisConfig,
  next: AnalysisConfig,
): Promise<void> {
  const resultChanged = (await configHash(previous)) !== (await configHash(next))
  if (!resultChanged) return
  deps.cancelEpoch.current += 1
  deps.analysisClient.current?.cancelPending()
  const epoch = deps.cancelEpoch.current
  for (const dataset of deps.datasets) {
    if (deps.cancelEpoch.current !== epoch) return
    if (!deps.datasetsRef.current.some((current) => current.name === dataset.name)) continue
    await runAnalysisFor(deps, {
      source: openedSourceForDataset(dataset),
      mapping: dataset.mapping,
      configOverride: next,
      epoch,
    })
  }
  if (
    deps.activeName !== null &&
    deps.datasetsRef.current.some((current) => current.name === deps.activeName)
  ) {
    deps.setActiveName(deps.activeName)
  }
}

/**
 * Apply a settings edit — and, when a number-changing key moved, re-analyse
 * every open dataset under the new configuration.
 *
 * The worker's cache key is `configHash`, which covers only the keys that
 * change results, so a theme or export-format edit re-renders without paying
 * for a re-run. The re-analysis cannot fail destructively: a dataset whose
 * retained table was evicted is re-opened from its `File`.
 */
export function applyConfigFor(deps: AnalyzerLoopDeps, next: AnalysisConfig): void {
  const previous = deps.config
  deps.setConfig(next)
  deps.setSettingsOpen(false)
  if (!saveConfig(next)) {
    deps.notify('warning', '設定をブラウザに保存できませんでした。今回のセッションのみ有効です。')
  }
  void reanalyseForConfig(deps, previous, next)
}

/**
 * Remove a dataset and release what only it held.
 *
 * `sourceFiles` and the worker's retained tables are keyed by content hash,
 * so a second dataset opened from identical bytes shares them — deleting or
 * releasing them here would break that sibling's next re-analysis. Only the
 * last dataset using a hash lets them go.
 */
export function closeDatasetFor(deps: AnalyzerLoopDeps, dataset: Dataset): void {
  deps.setDatasets((current) => current.filter((existing) => existing.name !== dataset.name))
  if (dataset.name === deps.activeName) {
    // Closing the on-screen dataset must not leave a selection and a
    // viewport aimed at data that is gone; activate the first remaining
    // file so the graph has something to frame.
    const next = deps.datasets.find((existing) => existing.name !== dataset.name)
    deps.setActiveName(next?.name ?? null)
    deps.setSelection(null)
    deps.setViewport(null)
  }
  const siblingOpen = deps.datasets.some(
    (other) => other.name !== dataset.name && other.sourceSha256 === dataset.sourceSha256,
  )
  if (!siblingOpen) {
    deps.sourceFiles.current.delete(dataset.sourceSha256)
    // A dead worker rejects here; the release is advisory cleanup, so the
    // rejection is expected noise rather than an error the user can act on.
    void deps
      .getAnalysisClient()
      .release(dataset.sourceSha256)
      .catch(() => {})
  }
  // If an analysis for this dataset is still in flight, its result must be
  // dropped when it lands rather than re-adding a dataset the user closed.
  deps.closedSources.current.add(dataset.filename)
  if (dataset.name === deps.cloudSubject) {
    // The sync lane's subject no longer exists: a failure naming it is stale,
    // and a retry that synced whatever is on screen would be worse.
    deps.setStatuses((current) =>
      current.sync.kind === 'failed' ? { ...current, sync: { kind: 'local-only' } } : current,
    )
  }
}

export interface AnalyzerLoop {
  pendingColumns: PendingColumnChoice | null
  setPendingColumns: Dispatch<SetStateAction<PendingColumnChoice | null>>
  runAnalysis: (
    source: OpenedSource,
    mapping: ColumnMapping,
    configOverride?: AnalysisConfig,
    reopenedOnce?: boolean,
    epoch?: number,
  ) => Promise<void>
  openFiles: (files: File[]) => Promise<void>
  confirmPendingColumns: (mapping: ColumnMapping) => void
  cancelPendingColumns: () => void
  cancelAnalysis: () => void
  applyConfig: (next: AnalysisConfig) => void
  closeDataset: (dataset: Dataset) => void
}

export interface AnalyzerLoopInput {
  getAnalysisClient: () => AnalysisClient
  analysisClient: { current: AnalysisClient | null }
  config: AnalysisConfig
  signedIn: boolean
  datasets: readonly Dataset[]
  activeName: string | null
  cloudSubject: string | null
  notify: (tone: NoticeItem['tone'], text: string) => void
  syncToCloud: (dataset: Dataset, analysedWith?: AnalysisConfig) => Promise<void>
  setStatuses: Dispatch<SetStateAction<CloudStatuses>>
  setDatasets: Dispatch<SetStateAction<Dataset[]>>
  setActiveName: Dispatch<SetStateAction<string | null>>
  setSelection: Dispatch<SetStateAction<SelectionRange | null>>
  setViewport: Dispatch<SetStateAction<ChartViewport | null>>
  setConfig: Dispatch<SetStateAction<AnalysisConfig>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
}

/**
 * The refs that outlive any one render: the recovery files, the close markers,
 * the paused batch, the cancel epoch, and the last committed dataset list.
 */
function useLoopRefs(): Pick<
  AnalyzerLoopDeps,
  'sourceFiles' | 'closedSources' | 'pendingFileQueue' | 'cancelEpoch' | 'datasetsRef'
> & {
  pendingColumns: PendingColumnChoice | null
  setPendingColumns: Dispatch<SetStateAction<PendingColumnChoice | null>>
} {
  const [pendingColumns, setPendingColumns] = useState<PendingColumnChoice | null>(null)
  const sourceFiles = useRef(new Map<string, File>())
  const closedSources = useRef(new Set<string>())
  const pendingFileQueue = useRef<File[]>([])
  const cancelEpoch = useRef(0)
  const datasetsRef = useRef<readonly Dataset[]>([])
  return {
    pendingColumns,
    setPendingColumns,
    sourceFiles,
    closedSources,
    pendingFileQueue,
    cancelEpoch,
    datasetsRef,
  }
}

/** The view-facing callbacks, each a thin forwarding shim over a `*For` function. */
function useLoopCallbacks(
  deps: AnalyzerLoopDeps,
): Omit<AnalyzerLoop, 'pendingColumns' | 'setPendingColumns'> {
  const runAnalysis = useCallback(
    (
      source: OpenedSource,
      mapping: ColumnMapping,
      configOverride?: AnalysisConfig,
      reopenedOnce?: boolean,
      epoch?: number,
    ) =>
      runAnalysisFor(deps, {
        source,
        mapping,
        configOverride,
        reopenedOnce,
        epoch: epoch ?? deps.cancelEpoch.current,
      }),
    [deps],
  )
  const openFiles = useCallback((files: File[]) => openFilesFor(deps, files), [deps])
  const confirmPendingColumns = useCallback(
    (mapping: ColumnMapping) => confirmPendingColumnsFor(deps, mapping),
    [deps],
  )
  const cancelPendingColumns = useCallback(() => cancelPendingColumnsFor(deps), [deps])
  const cancelAnalysis = useCallback(() => cancelAnalysisFor(deps), [deps])
  const applyConfig = useCallback((next: AnalysisConfig) => applyConfigFor(deps, next), [deps])
  const closeDataset = useCallback((dataset: Dataset) => closeDatasetFor(deps, dataset), [deps])
  return {
    runAnalysis,
    openFiles,
    confirmPendingColumns,
    cancelPendingColumns,
    cancelAnalysis,
    applyConfig,
    closeDataset,
  }
}

/**
 * The open/analyse lane's state and callbacks, kept identical in shape to the
 * ones `AnalyzerScreen` used to declare inline.
 */
export function useAnalyzerLoop(input: AnalyzerLoopInput): AnalyzerLoop {
  const {
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
  } = input
  const owned = useLoopRefs()

  useEffect(() => {
    owned.datasetsRef.current = datasets
  }, [owned, datasets])

  // Field-level deps keep `deps` stable across renders that change none of
  // them — effects downstream hold the callbacks by identity.
  const deps: AnalyzerLoopDeps = useMemo(
    () => ({
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
      ...owned,
    }),
    [
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
      owned,
    ],
  )

  return {
    pendingColumns: owned.pendingColumns,
    setPendingColumns: owned.setPendingColumns,
    ...useLoopCallbacks(deps),
  }
}
