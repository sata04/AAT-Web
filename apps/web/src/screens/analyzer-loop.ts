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
import {
  type Dataset,
  datasetFromPayload,
  datasetNameFromFilename,
  openedSourceForDataset,
} from '../app/dataset.ts'
import { saveConfig } from '../app/settings.ts'
import type { CloudStatuses } from '../cloud/status.ts'
import { useMountedRef } from '../components/hooks.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { PendingColumnChoice } from './AnalyzerView.tsx'

/**
 * Everything the open/analyse lane touches, handed in as one object so the
 * callables below read like the component body they were lifted from.
 */
export interface AnalyzerLoopDeps {
  mounted: { current: boolean }
  requests: { current: Map<symbol, AnalysisRequest> }
  imports: { current: WeakMap<Dataset, AnalysisRequest> }
  releaseCandidates: { current: Set<string> }
  syncRequested: { current: WeakSet<Dataset> }
  /** The account the current `syncRequested` markers were issued under. */
  syncRequestedUser: { current: string | null }
  /** Builds the worker client on first use; page load alone must not start one. */
  getAnalysisClient: () => AnalysisClient
  /** The live client ref — read by paths that only cancel, which must not construct one. */
  analysisClient: { current: AnalysisClient | null }
  config: AnalysisConfig
  signedIn: boolean
  /** Signed-in account identity; null while signed out or still loading. */
  sessionUserId: string | null
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
  pendingFileQueue: { current: PendingImport[] }
  /** Bumped on every cancel; an open/analyse loop reads it to stop cleanly. */
  cancelEpoch: { current: number }
  /** The dataset list as of the last commit — re-analysis loops read it mid-flight. */
  datasetsRef: { current: readonly Dataset[] }
}

/** An open owns a source token; re-analysis replaces the request, retaining its ownership. */
interface AnalysisRequest {
  sourceId: symbol
  filename: string
  sourceSha256?: string
  importId: symbol
  localOnly: boolean
  pending: boolean
  installing: boolean
}

interface PendingImport {
  file: File
  request: AnalysisRequest
}

export interface ImportOptions {
  localOnly?: boolean
  importId?: symbol
}

/**
 * Tables share a content hash, but an open owns its own filename and token.
 * Reserve names before reading: even two unknown sources with the same basename
 * must have distinct dataset keys. The File itself remains the recovery bytes.
 */
function reserveFilename(deps: AnalyzerLoopDeps, filename: string): string {
  const taken = new Set(deps.datasetsRef.current.map((dataset) => dataset.name))
  for (const request of deps.requests.current.values()) {
    if (request.pending || request.installing) taken.add(datasetNameFromFilename(request.filename))
  }
  const name = datasetNameFromFilename(filename)
  const extension = filename.slice(
    filename.lastIndexOf('.') > 0 ? filename.lastIndexOf('.') : filename.length,
  )
  let candidate = filename
  for (let suffix = 2; taken.has(datasetNameFromFilename(candidate)); suffix++) {
    candidate = `${name} (${suffix})${extension}`
  }
  return candidate
}

/** Reconstructed sources retain the open's ownership by reserved filename + hash. */
function requestForSource(
  deps: AnalyzerLoopDeps,
  source: Pick<OpenedSource, 'filename' | 'sourceSha256'>,
): AnalysisRequest | undefined {
  const dataset = deps.datasetsRef.current.find(
    (dataset) => dataset.filename === source.filename && dataset.sourceSha256 === source.sourceSha256,
  )
  const owner = dataset === undefined ? undefined : deps.imports.current.get(dataset)
  return (
    owner ??
    [...deps.requests.current.values()].find(
      (request) =>
        (request.pending || request.installing) &&
        request.filename === source.filename &&
        request.sourceSha256 === source.sourceSha256,
    )
  )
}

function releaseUnusedSources(deps: AnalyzerLoopDeps): void {
  if (!deps.mounted.current) return
  const requests = [...deps.requests.current.values()]
  for (const hash of deps.releaseCandidates.current) {
    const owned =
      deps.datasetsRef.current.some((dataset) => {
        if (dataset.sourceSha256 !== hash) return false
        const owner = deps.imports.current.get(dataset)
        return owner === undefined
          ? !deps.closedSources.current.has(dataset.filename)
          : deps.requests.current.has(owner.sourceId)
      }) ||
      requests.some((request) => request.sourceSha256 === hash && (request.pending || request.installing))
    if (owned) {
      deps.releaseCandidates.current.delete(hash)
      continue
    }
    // An open still reading/parsing may return this same hash. Defer eviction
    // until its hash is known (or it is cancelled), then reconsider the candidate.
    if (requests.some((request) => request.pending && request.sourceSha256 === undefined)) continue
    deps.releaseCandidates.current.delete(hash)
    deps.sourceFiles.current.delete(hash)
    // Cleanup never creates a worker; a disposed worker may reject the advisory release.
    void deps.analysisClient.current?.release(hash).catch(() => {})
  }
}

function releaseSourceIfUnused(deps: AnalyzerLoopDeps, hash: string): void {
  deps.releaseCandidates.current.add(hash)
  releaseUnusedSources(deps)
}

function isCurrent(
  deps: AnalyzerLoopDeps,
  filename: string,
  epoch: number,
  request?: AnalysisRequest,
): boolean {
  return (
    deps.mounted.current &&
    epoch === deps.cancelEpoch.current &&
    (request === undefined
      ? !deps.closedSources.current.has(filename)
      : deps.requests.current.get(request.sourceId) === request)
  )
}

/** Everything `runAnalysisFor` needs to describe one request. */
interface AnalysisJob {
  request?: AnalysisRequest
  source: OpenedSource
  mapping: ColumnMapping
  configOverride?: AnalysisConfig | undefined
  /** Set when this attempt is already a re-open, so it cannot recurse. */
  reopenedOnce?: boolean | undefined
  /**
   * Tour-generated files open local-only: the tour's own caption promises
   * nothing leaves the browser, so its samples must not create a cloud
   * revision or poster job even when the session is signed in.
   */
  localOnly?: boolean | undefined
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
  request: AnalysisRequest
}

/**
 * A result the workspace no longer wants — the user closed the file while
 * the worker computed it, or the epoch went stale (cancel, or a newer
 * settings application whose own re-analysis supersedes it). Shared retained
 * tables stay available to the request or sibling dataset that still needs them.
 */
function dropUnwantedInstall(deps: AnalyzerLoopDeps, installed: InstalledAnalysis): boolean {
  const { source, epoch, request } = installed
  if (isCurrent(deps, source.filename, epoch, request)) return false
  request.pending = false
  releaseSourceIfUnused(deps, source.sourceSha256)
  return true
}

/**
 * Install a finished analysis — unless `dropUnwantedInstall` claims it.
 */
async function installAnalysisResult(deps: AnalyzerLoopDeps, installed: InstalledAnalysis): Promise<void> {
  const { result, effectiveConfig, request } = installed
  if (dropUnwantedInstall(deps, installed)) return
  const dataset = datasetFromPayload(result.payload, effectiveConfig, result.fromCache)
  request.pending = false
  request.installing = true
  deps.imports.current.set(dataset, request)
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
}

/** Reconcile completed imports after authentication or an analysis commit, once per result. */
export function reconcileCloudFor(deps: AnalyzerLoopDeps): void {
  if (!deps.mounted.current) return
  // The analyzer stays mounted across sign-out/sign-in; a different account
  // must not inherit the previous user's markers, or its open datasets would
  // never reach the new account's revisions. The check runs before the
  // sign-in gate on purpose: a sync interrupted by sign-out fails under the
  // previous identity, and without recording that transition the marker
  // would still match when the same account signs back in — skipping the
  // dataset forever.
  if (deps.syncRequestedUser.current !== deps.sessionUserId) {
    deps.syncRequestedUser.current = deps.sessionUserId
    deps.syncRequested.current = new WeakSet()
  }
  if (!deps.signedIn) return
  for (const dataset of deps.datasetsRef.current) {
    const request = deps.imports.current.get(dataset)
    if (request === undefined || request.localOnly || deps.syncRequested.current.has(dataset)) continue
    const latest = deps.requests.current.get(request.sourceId)
    if (latest !== request && latest?.pending) continue
    // A failed attempt belongs to the existing retry control, not every subsequent render.
    deps.syncRequested.current.add(dataset)
    void deps.syncToCloud(dataset)
  }
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
    const bytes = await file.arrayBuffer()
    if (!isCurrent(deps, job.source.filename, job.epoch ?? deps.cancelEpoch.current, job.request)) return true
    const reopened = await client.open(job.source.filename, bytes)
    if (!isCurrent(deps, job.source.filename, job.epoch ?? deps.cancelEpoch.current, job.request)) {
      if (job.request !== undefined) job.request.pending = false
      releaseSourceIfUnused(deps, reopened.sourceSha256)
      return true
    }
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
  if (!isCurrent(deps, job.source.filename, job.epoch ?? deps.cancelEpoch.current, job.request)) return
  if (reportMissingColumns(deps, error, job)) return
  if (job.request !== undefined) job.request.pending = false
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
  if (!isCurrent(deps, source.filename, epoch, job.request)) return
  const owner = requestForSource(deps, source)
  const request = job.request ?? {
    sourceId: owner?.sourceId ?? Symbol(source.filename),
    filename: source.filename,
    sourceSha256: source.sourceSha256,
    importId: owner?.importId ?? Symbol(source.filename),
    localOnly: owner?.localOnly ?? job.localOnly ?? false,
    pending: true,
    installing: false,
  }
  deps.requests.current.set(request.sourceId, request)
  const client = deps.getAnalysisClient()
  const effectiveConfig = configOverride ?? deps.config
  const onProgress = (progress: AnalysisProgress) => {
    if (!isCurrent(deps, source.filename, epoch, request)) return
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
    await installAnalysisResult(deps, {
      source,
      result,
      effectiveConfig,
      epoch,
      request,
    })
  } catch (error) {
    if (!isCurrent(deps, source.filename, epoch, request)) {
      request.pending = false
      releaseSourceIfUnused(deps, source.sourceSha256)
      return
    }
    await reportAnalysisError(deps, client, error, { ...job, epoch, request })
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
  batch: { epoch: number; request: AnalysisRequest },
): Promise<'done' | 'columns' | 'stop'> {
  const { epoch, request } = batch
  const filename = request.filename
  try {
    const bytes = await file.arrayBuffer()
    if (!isCurrent(deps, filename, epoch, request)) return 'stop'
    const source = await client.open(filename, bytes, (progress) => {
      if (!isCurrent(deps, filename, epoch, request)) return
      deps.setStatuses((current) => ({
        ...current,
        analysis: { kind: 'running', stage: progress.stage, percent: progress.percent },
      }))
    })
    request.sourceSha256 = source.sourceSha256
    if (!isCurrent(deps, filename, epoch, request)) {
      request.pending = false
      releaseSourceIfUnused(deps, source.sourceSha256)
      return 'stop'
    }
    deps.sourceFiles.current.set(source.sourceSha256, file)
    releaseUnusedSources(deps)
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
    await runAnalysisFor(deps, { source, mapping: source.suggestedMapping, epoch, request })
    return 'done'
  } catch (error) {
    if (!isCurrent(deps, filename, epoch, request)) return 'stop'
    request.pending = false
    return reportOpenError(deps, filename, error) === 'cancelled' ? 'stop' : 'done'
  }
}

export async function openFilesFor(
  deps: AnalyzerLoopDeps,
  files: File[],
  options: ImportOptions = {},
): Promise<void> {
  if (!deps.mounted.current) return
  // Reserve the entire batch before reading any bytes, including files waiting for a column dialog.
  const pending = files.map((file) => {
    const filename = reserveFilename(deps, file.name)
    const request: AnalysisRequest = {
      sourceId: Symbol(filename),
      filename,
      importId: options.importId ?? Symbol(file.name),
      localOnly: options.localOnly === true,
      pending: true,
      installing: false,
    }
    deps.requests.current.set(request.sourceId, request)
    deps.closedSources.current.delete(filename)
    return { file, request }
  })
  await openReservedFilesFor(deps, pending)
}

async function openReservedFilesFor(deps: AnalyzerLoopDeps, files: PendingImport[]): Promise<void> {
  if (!deps.mounted.current) return
  const epoch = deps.cancelEpoch.current
  for (let index = 0; index < files.length; index++) {
    if (!deps.mounted.current || deps.cancelEpoch.current !== epoch) break
    const { file, request } = files[index] as PendingImport
    if (!isCurrent(deps, request.filename, epoch, request)) continue
    deps.setStatuses((current) => ({
      ...current,
      analysis: { kind: 'running', stage: 'decoding', percent: 0 },
    }))
    const outcome = await openSingleFile(deps, deps.getAnalysisClient(), file, { epoch, request })
    if (outcome === 'stop') {
      if (!deps.mounted.current || deps.cancelEpoch.current !== epoch) break
      continue
    }
    if (outcome === 'columns') {
      deps.pendingFileQueue.current = files.slice(index + 1)
      return
    }
  }
  for (const { request } of files) request.pending = false
  releaseUnusedSources(deps)
}

/** What remains of a batch once the column dialog has spoken for this file. */
export function drainPendingFilesFor(deps: AnalyzerLoopDeps): void {
  const rest = deps.pendingFileQueue.current
  deps.pendingFileQueue.current = []
  if (rest.length > 0) void openReservedFilesFor(deps, rest)
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
    if (deps.mounted.current && deps.cancelEpoch.current === epoch) drainPendingFilesFor(deps)
  })
}

/** Cancel skips this file; the rest of the batch still deserves its answer. */
export function cancelPendingColumnsFor(deps: AnalyzerLoopDeps): void {
  if (deps.pendingColumns !== null) {
    const request = requestForSource(deps, deps.pendingColumns.source)
    if (request !== undefined) {
      request.pending = false
      // A cancelled open never owns the hash: its File and parsed table would
      // otherwise stay retained with no dataset to release them.
      if (request.sourceSha256 !== undefined) releaseSourceIfUnused(deps, request.sourceSha256)
    }
  }
  deps.setPendingColumns(null)
  releaseUnusedSources(deps)
  drainPendingFilesFor(deps)
}

/**
 * Abort whatever the worker is doing. `cancelPending` resolves every
 * in-flight request with `ANALYSIS_CANCELLED`, which the catch paths above
 * turn into the `cancelled` status rather than a failure.
 */
export function cancelAnalysisFor(deps: AnalyzerLoopDeps): void {
  deps.cancelEpoch.current += 1
  for (const request of deps.requests.current.values()) request.pending = false
  deps.pendingFileQueue.current = []
  deps.analysisClient.current?.cancelPending()
  releaseUnusedSources(deps)
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
  if (!resultChanged || !deps.mounted.current) return
  deps.cancelEpoch.current += 1
  for (const request of deps.requests.current.values()) request.pending = false
  deps.pendingFileQueue.current = []
  deps.analysisClient.current?.cancelPending()
  releaseUnusedSources(deps)
  const epoch = deps.cancelEpoch.current
  for (const dataset of deps.datasets) {
    if (!deps.mounted.current || deps.cancelEpoch.current !== epoch) return
    if (!deps.datasetsRef.current.some((current) => current.name === dataset.name)) continue
    await runAnalysisFor(deps, {
      source: openedSourceForDataset(dataset),
      mapping: dataset.mapping,
      configOverride: next,
      epoch,
    })
  }
  if (
    deps.mounted.current &&
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
 * last dataset or pending open using a hash lets them go.
 */
export function closeDatasetFor(deps: AnalyzerLoopDeps, dataset: Dataset): void {
  const owningImport = deps.imports.current.get(dataset)
  const belongsToClosedImport = (existing: Dataset) =>
    existing.name === dataset.name &&
    (existing === dataset ||
      (owningImport !== undefined && deps.imports.current.get(existing)?.sourceId === owningImport.sourceId))
  const current = deps.datasetsRef.current.find((existing) => existing.name === dataset.name)
  if (current !== undefined && !belongsToClosedImport(current)) return
  // Include re-analyses of this import that React has queued but has not committed yet.
  deps.setDatasets((current) => current.filter((existing) => !belongsToClosedImport(existing)))
  if (dataset.name === deps.activeName) {
    const next = deps.datasetsRef.current.find((existing) => !belongsToClosedImport(existing))
    deps.setActiveName(next?.name ?? null)
    deps.setSelection(null)
    deps.setViewport(null)
  }
  // Invalidate this open's request, never another source that shares its bytes.
  const request = owningImport ?? requestForSource(deps, dataset)
  if (request !== undefined) deps.requests.current.delete(request.sourceId)
  deps.closedSources.current.add(dataset.filename)
  releaseSourceIfUnused(deps, dataset.sourceSha256)
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
  openFiles: (files: File[], options?: ImportOptions) => Promise<void>
  pendingNames: () => ReadonlySet<string>
  importIdFor: (dataset: Dataset) => symbol | undefined
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
  /** Signed-in account identity; null while signed out or still loading. */
  sessionUserId: string | null
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
  | 'sourceFiles'
  | 'closedSources'
  | 'pendingFileQueue'
  | 'cancelEpoch'
  | 'datasetsRef'
  | 'mounted'
  | 'requests'
  | 'imports'
  | 'releaseCandidates'
  | 'syncRequested'
  | 'syncRequestedUser'
> & {
  pendingColumns: PendingColumnChoice | null
  setPendingColumns: Dispatch<SetStateAction<PendingColumnChoice | null>>
} {
  const [pendingColumns, setPendingColumns] = useState<PendingColumnChoice | null>(null)
  const sourceFiles = useRef(new Map<string, File>())
  const closedSources = useRef(new Set<string>())
  const pendingFileQueue = useRef<PendingImport[]>([])
  const mounted = useMountedRef()
  const requests = useRef(new Map<symbol, AnalysisRequest>())
  const imports = useRef(new WeakMap<Dataset, AnalysisRequest>())
  const releaseCandidates = useRef(new Set<string>())
  const syncRequested = useRef(new WeakSet<Dataset>())
  const syncRequestedUser = useRef<string | null>(null)
  const cancelEpoch = useRef(0)
  const datasetsRef = useRef<readonly Dataset[]>([])
  useEffect(
    () => () => {
      // StrictMode may restore mounted=true; the old lifetime's reads must still stay invalid.
      cancelEpoch.current += 1
      pendingFileQueue.current = []
      requests.current.clear()
    },
    [],
  )
  return {
    mounted,
    requests,
    imports,
    releaseCandidates,
    syncRequested,
    syncRequestedUser,
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
  const openFiles = useCallback(
    (files: File[], options?: ImportOptions) => openFilesFor(deps, files, options),
    [deps],
  )
  const confirmPendingColumns = useCallback(
    (mapping: ColumnMapping) => confirmPendingColumnsFor(deps, mapping),
    [deps],
  )
  const cancelPendingColumns = useCallback(() => cancelPendingColumnsFor(deps), [deps])
  const cancelAnalysis = useCallback(() => cancelAnalysisFor(deps), [deps])
  const applyConfig = useCallback((next: AnalysisConfig) => applyConfigFor(deps, next), [deps])
  const closeDataset = useCallback((dataset: Dataset) => closeDatasetFor(deps, dataset), [deps])
  return {
    pendingNames: () =>
      new Set(
        [...deps.requests.current.values()]
          .filter((request) => request.pending || request.installing)
          .map((request) => datasetNameFromFilename(request.filename)),
      ),
    importIdFor: (dataset) => deps.imports.current.get(dataset)?.importId,
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
    sessionUserId,
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
    // A finished import still reserves its name until React commits its dataset.
    for (const dataset of datasets) {
      const request = owned.imports.current.get(dataset)
      if (request !== undefined) request.installing = false
    }
  }, [owned, datasets])

  // Field-level deps keep `deps` stable across renders that change none of
  // them — effects downstream hold the callbacks by identity.
  const deps: AnalyzerLoopDeps = useMemo(
    () => ({
      getAnalysisClient,
      analysisClient,
      config,
      signedIn,
      sessionUserId,
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
      sessionUserId,
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

  useEffect(() => reconcileCloudFor(deps), [deps])

  return {
    pendingColumns: owned.pendingColumns,
    setPendingColumns: owned.setPendingColumns,
    ...useLoopCallbacks(deps),
  }
}
