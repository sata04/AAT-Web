/**
 * The run-detail screen's data lane: the effects that load the run, its
 * revisions, and the selected revision's metrics and posters, plus the
 * actions behind the screen's buttons. `RunDetailScreen` wires them to the
 * JSX; the bodies live here so the screen reads as wiring.
 */

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react'
import {
  deleteRun,
  fetchRevision,
  fetchRun,
  listPosters,
  listRevisions,
  type PosterFigure,
  type RevisionSummary,
  type RunSummary,
  updateRun,
} from '../cloud/gateway.ts'
import type { PosterStatus } from '../cloud/status.ts'
import { useMountedRef } from '../components/hooks.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import type { MemoSaveOutcome } from '../components/RunMemoEditor.tsx'
import { saveBlob } from '../exporting/client.ts'
import {
  generateAutoPoster,
  type PosterContext,
  type PosterRequestOutcome,
  retryAutoPoster,
} from '../poster/requests.ts'
import { downloadSourceBackup, fetchSnapshotBytes } from '../runs/api.ts'
import { latestRevision } from '../runs/facts.ts'
import { decodeRunMetrics, type RunMetrics } from '../runs/metrics.ts'
import { decodeSnapshotBytes, type ReplayedAnalysis, replayFromSnapshot } from '../runs/replay.ts'
import type { SessionStatus } from '../session/SessionProvider.tsx'

export type LoadState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'error'; message: string }

export type ReplayState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; revisionId: string; replay: ReplayedAnalysis }
  | { kind: 'error'; message: string }

/**
 * What is known about the original-CSV backup.
 *
 * `unknown` is the honest starting point and stays that way until the reader asks. There is no
 * route that reports whether a source object exists without streaming it, and streaming it writes
 * a `source.download` entry to the audit log — so probing on page load would put a record of a
 * download nobody performed into the security log in order to fill in a badge. See
 * `src/runs/api.ts`.
 */
export type SourceState =
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'present'; bytes: number; filename: string }
  | { kind: 'absent' }
  | { kind: 'error'; message: string }

type Notify = (tone: NoticeItem['tone'], text: string) => void

function runLoadOutcome(outcome: Awaited<ReturnType<typeof fetchRun>>): LoadState<RunSummary> {
  if (outcome.ok) return { kind: 'ready', value: outcome.value.run }
  // The gateway cannot distinguish "no cloud" from "no such run", so neither does this.
  return {
    kind: 'error',
    message:
      outcome.kind === 'unavailable'
        ? 'この実験は見つからないか、クラウドに接続できません。一覧から選び直してください。'
        : outcome.message,
  }
}

function loadRun(
  mounted: { current: boolean },
  sessionStatus: SessionStatus,
  runId: string,
  setRun: Dispatch<SetStateAction<LoadState<RunSummary>>>,
): void {
  if (sessionStatus !== 'signed-in' || runId === '') return
  setRun({ kind: 'loading' })
  void fetchRun(runId).then((outcome) => {
    if (!mounted.current) return
    setRun(runLoadOutcome(outcome))
  })
}

function loadRevisions(
  mounted: { current: boolean },
  sessionStatus: SessionStatus,
  runId: string,
  sinks: {
    setRevisions: Dispatch<SetStateAction<readonly RevisionSummary[]>>
    setSelectedRevisionId: Dispatch<SetStateAction<string | null>>
  },
): void {
  if (sessionStatus !== 'signed-in' || runId === '') return
  void listRevisions(runId).then((outcome) => {
    if (!mounted.current || !outcome.ok) return
    sinks.setRevisions(outcome.value.revisions)
    // Keep an existing selection only when it belongs to this run — the screen is reused across
    // run navigation, and a previous run's id resolves to nothing here. Otherwise take the current
    // analysis, which is the highest revision number — see `latestRevision` for why not the newest
    // timestamp.
    sinks.setSelectedRevisionId((current) =>
      current !== null && outcome.value.revisions.some((revision) => revision.id === current)
        ? current
        : (latestRevision(outcome.value.revisions)?.id ?? null),
    )
  })
}

function loadRevisionDetails(
  mounted: { current: boolean },
  selectedRevisionId: string | null,
  setMetrics: Dispatch<SetStateAction<RunMetrics | null>>,
  setPosters: Dispatch<SetStateAction<readonly PosterFigure[]>>,
): (() => void) | undefined {
  if (selectedRevisionId === null) return undefined
  // Two fetches race whenever the user switches revision quickly: without
  // this flag the slower, older response would overwrite the newer metrics
  // and posters and nothing would ever correct it.
  let superseded = false
  setMetrics(null)
  setPosters([])
  void fetchRevision(selectedRevisionId).then((outcome) => {
    if (!mounted.current || superseded || !outcome.ok) return
    setMetrics(decodeRunMetrics(outcome.value.metrics))
  })
  void listPosters(selectedRevisionId).then((outcome) => {
    if (!mounted.current || superseded || !outcome.ok) return
    setPosters(outcome.value.posters)
  })
  return () => {
    superseded = true
  }
}

// A revision change invalidates a replay: the samples on screen belong to the analysis that was
// open, and silently leaving them under a different revision's heading would attribute one
// measurement's numbers to another.
function invalidateStaleReplay(
  selectedRevisionId: string | null,
  setReplay: Dispatch<SetStateAction<ReplayState>>,
): void {
  setReplay((current) =>
    current.kind === 'ready' && current.revisionId !== selectedRevisionId ? { kind: 'idle' } : current,
  )
}

export interface RunDetailData {
  mounted: { current: boolean }
  run: LoadState<RunSummary>
  setRun: Dispatch<SetStateAction<LoadState<RunSummary>>>
  revisions: readonly RevisionSummary[]
  selectedRevisionId: string | null
  setSelectedRevisionId: Dispatch<SetStateAction<string | null>>
  metrics: RunMetrics | null
  posters: readonly PosterFigure[]
  setPosters: Dispatch<SetStateAction<readonly PosterFigure[]>>
  replay: ReplayState
  setReplay: Dispatch<SetStateAction<ReplayState>>
  source: SourceState
  setSource: Dispatch<SetStateAction<SourceState>>
}

/** The screen's loaded state and the effects that fill it. */
export function useRunDetailData(sessionStatus: SessionStatus, runId: string): RunDetailData {
  const mounted = useMountedRef()
  const [run, setRun] = useState<LoadState<RunSummary>>({ kind: 'loading' })
  const [revisions, setRevisions] = useState<readonly RevisionSummary[]>([])
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<RunMetrics | null>(null)
  const [posters, setPosters] = useState<readonly PosterFigure[]>([])
  const [replay, setReplay] = useState<ReplayState>({ kind: 'idle' })
  const [source, setSource] = useState<SourceState>({ kind: 'unknown' })

  useEffect(() => loadRun(mounted, sessionStatus, runId, setRun), [mounted, sessionStatus, runId])
  useEffect(
    () => loadRevisions(mounted, sessionStatus, runId, { setRevisions, setSelectedRevisionId }),
    [mounted, sessionStatus, runId],
  )
  useEffect(
    () => loadRevisionDetails(mounted, selectedRevisionId, setMetrics, setPosters),
    [mounted, selectedRevisionId],
  )
  useEffect(() => invalidateStaleReplay(selectedRevisionId, setReplay), [selectedRevisionId])

  return {
    mounted,
    run,
    setRun,
    revisions,
    selectedRevisionId,
    setSelectedRevisionId,
    metrics,
    posters,
    setPosters,
    replay,
    setReplay,
    source,
    setSource,
  }
}

/**
 * Write a memo or tag patch to the run, reporting the outcome in the shape
 * the memo editor expects.
 */
export async function patchRunFor(
  runId: string,
  patch: { memo?: string | null; tags?: readonly string[] },
  successText: string | null,
  notify: Notify,
): Promise<MemoSaveOutcome> {
  const outcome = await updateRun(runId, patch)
  if (!outcome.ok) {
    return {
      ok: false,
      message: outcome.message,
      retryable: outcome.kind === 'unavailable' || outcome.retryable,
    }
  }
  if (successText !== null) notify('info', successText)
  return { ok: true }
}

function snapshotErrorMessage(
  outcome: Extract<Awaited<ReturnType<typeof fetchSnapshotBytes>>, { ok: false }>,
): string {
  return outcome.kind === 'error' && outcome.code === 'RESOURCE_NOT_FOUND'
    ? 'このリビジョンにはスナップショットが保存されていません。'
    : outcome.message
}

export async function openSnapshotFor(
  mounted: { current: boolean },
  revision: RevisionSummary,
  setReplay: Dispatch<SetStateAction<ReplayState>>,
): Promise<void> {
  setReplay({ kind: 'loading' })
  const outcome = await fetchSnapshotBytes(revision.id)
  if (!mounted.current) return
  if (!outcome.ok) {
    setReplay({ kind: 'error', message: snapshotErrorMessage(outcome) })
    return
  }
  try {
    const snapshot = await decodeSnapshotBytes(outcome.value)
    if (!mounted.current) return
    setReplay({ kind: 'ready', revisionId: revision.id, replay: replayFromSnapshot(snapshot) })
  } catch (error) {
    if (!mounted.current) return
    setReplay({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

function posterFailureText(outcome: Extract<PosterRequestOutcome, { ok: false }>): string {
  // A spec refusal is advice with the numbers in it; a cloud refusal is the taxonomy message.
  return outcome.kind === 'spec'
    ? [outcome.advice.message, outcome.advice.detail].filter((part) => part !== null).join('\n')
    : outcome.message
}

/**
 * Ask for the automatic figure, or retry one that failed.
 *
 * Both go through `src/poster/requests.ts`, which is the analyzer's own path: it builds the spec
 * from the frozen preset and the dataset's branded arrays, submits it, and polls the *listing* —
 * never the render endpoint — until the figure settles. Sharing that rather than reimplementing
 * it is what keeps "the automatic poster of this revision" one document with one spec hash,
 * whichever screen asked for it.
 *
 * Retry is offered for the automatic figure only. `POST /posters/:id/retry` needs the full spec
 * in the body, and `listPosters` returns a figure's status and hashes but not its document — so a
 * custom figure's range, size and DPI cannot be reconstructed from anything this screen holds.
 * Retrying it with invented parameters under its original id would file a different picture as
 * the same one, so the panel says to re-create it from the dialog instead.
 */
export async function runAutoPosterFor(
  deps: {
    mounted: { current: boolean }
    replay: ReplayState
    run: LoadState<RunSummary>
    notify: Notify
    setBusy: Dispatch<SetStateAction<boolean>>
    setAutoPosterStatus: Dispatch<SetStateAction<PosterStatus>>
    setPosters: Dispatch<SetStateAction<readonly PosterFigure[]>>
  },
  posterId: string | null,
): Promise<void> {
  if (deps.replay.kind !== 'ready' || deps.run.kind !== 'ready') return
  const context: PosterContext = {
    revisionId: deps.replay.revisionId,
    runCode: deps.run.value.runCode,
    dataset: deps.replay.replay.dataset,
  }
  deps.setBusy(true)
  const outcome =
    posterId === null
      ? await generateAutoPoster(context, deps.setAutoPosterStatus)
      : await retryAutoPoster(context, posterId, deps.setAutoPosterStatus)
  if (!deps.mounted.current) return
  deps.setBusy(false)

  if (!outcome.ok) {
    deps.notify('error', posterFailureText(outcome))
    return
  }
  deps.setPosters((current) => [
    outcome.poster,
    ...current.filter((existing) => existing.posterId !== outcome.poster.posterId),
  ])
  deps.notify('info', '自動ポスター図を生成しました。')
}

export async function getSourceFor(deps: {
  mounted: { current: boolean }
  run: LoadState<RunSummary>
  runId: string
  setSource: Dispatch<SetStateAction<SourceState>>
}): Promise<void> {
  if (deps.run.kind !== 'ready') return
  deps.setSource({ kind: 'checking' })
  const outcome = await downloadSourceBackup(deps.runId)
  if (!deps.mounted.current) return
  if (!outcome.ok) {
    deps.setSource(
      outcome.kind === 'error' && outcome.code === 'RESOURCE_NOT_FOUND'
        ? { kind: 'absent' }
        : { kind: 'error', message: outcome.message },
    )
    return
  }
  const filename = outcome.value.filename ?? deps.run.value.originalFilename
  saveBlob(outcome.value.blob, filename)
  deps.setSource({ kind: 'present', bytes: outcome.value.blob.size, filename })
}

export async function removeRunFor(deps: {
  runId: string
  setBusy: Dispatch<SetStateAction<boolean>>
  setConfirmingDelete: Dispatch<SetStateAction<boolean>>
  notify: Notify
  navigate: (to: string) => void
}): Promise<void> {
  deps.setBusy(true)
  const outcome = await deleteRun(deps.runId)
  deps.setBusy(false)
  deps.setConfirmingDelete(false)
  if (!outcome.ok) {
    deps.notify('error', outcome.message)
    return
  }
  deps.navigate('/runs')
}

/**
 * The tag editor's onChange: optimistically write, then roll back if the
 * server refuses.
 *
 * Roll the optimistic change back rather than leaving the screen showing a tag
 * the database does not have.
 */
export function saveTagsFor(
  deps: {
    runId: string
    current: RunSummary
    mounted: { current: boolean }
    notify: Notify
    setRun: Dispatch<SetStateAction<LoadState<RunSummary>>>
  },
  tags: readonly string[],
): void {
  const previous = deps.current.tags
  deps.setRun((state) =>
    state.kind === 'ready' ? { kind: 'ready', value: { ...state.value, tags: [...tags] } } : state,
  )
  void patchRunFor(deps.runId, { tags }, 'タグを保存しました。', deps.notify).then((outcome) => {
    if (!outcome.ok && deps.mounted.current) {
      deps.setRun((state) =>
        state.kind === 'ready' ? { kind: 'ready', value: { ...state.value, tags: [...previous] } } : state,
      )
      deps.notify('error', outcome.message)
    }
  })
}

/** Functional, so the write advances whatever the screen holds now rather than the copy a debounced save closed over. */
export function applySavedMemo(
  setRun: Dispatch<SetStateAction<LoadState<RunSummary>>>,
  value: string | null,
): void {
  setRun((state) =>
    state.kind === 'ready' ? { kind: 'ready', value: { ...state.value, memo: value } } : state,
  )
}
