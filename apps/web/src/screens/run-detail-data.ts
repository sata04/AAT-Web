/**
 * The run-detail screen's data lane: the effects that load the run, its
 * revisions, and the selected revision's metrics and posters, plus the
 * actions behind the screen's buttons. `RunDetailScreen` wires them to the
 * JSX; the bodies live here so the screen reads as wiring.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type CloudOutcome,
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
  | { kind: 'loading'; requestId: symbol }
  | { kind: 'ready'; revisionId: string; replay: ReplayedAnalysis; scope?: RevisionScope }
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

/** Child failures retain the last successful value, but can never masquerade as empty history. */
export type ChildResource<T> =
  | { kind: 'loading' | 'ready'; value: T }
  | { kind: 'error'; value: T; message: string }

export interface RevisionScope {
  revisionId: string | null
  current: boolean
  onInvalidate?: () => void
}

const NO_REVISIONS: readonly RevisionSummary[] = []
const NO_POSTERS: readonly PosterFigure[] = []

async function fetchRevisions(runId: string): Promise<CloudOutcome<readonly RevisionSummary[]>> {
  const outcome = await listRevisions(runId)
  return outcome.ok ? { ok: true, value: outcome.value.revisions } : outcome
}
async function fetchMetrics(revisionId: string): Promise<CloudOutcome<RunMetrics | null>> {
  const outcome = await fetchRevision(revisionId)
  return outcome.ok ? { ok: true, value: decodeRunMetrics(outcome.value.metrics) } : outcome
}
async function fetchPosters(revisionId: string): Promise<CloudOutcome<readonly PosterFigure[]>> {
  const outcome = await listPosters(revisionId)
  return outcome.ok ? { ok: true, value: outcome.value.posters } : outcome
}

function useChildResource<T>(
  key: string | null,
  empty: T,
  fetchValue: (id: string) => Promise<CloudOutcome<T>>,
) {
  const [stored, setStored] = useState<{ key: string | null; resource: ChildResource<T> }>(() => ({
    key,
    resource: { kind: 'loading', value: empty },
  }))
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: A retry must refetch the same resource key.
  useEffect(() => {
    if (key === null) return
    let current = true
    setStored((previous) => ({
      key,
      resource: { kind: 'loading', value: previous.key === key ? previous.resource.value : empty },
    }))
    void fetchValue(key).then((outcome) => {
      if (!current) return
      setStored((previous) => ({
        key,
        resource: outcome.ok
          ? { kind: 'ready', value: outcome.value }
          : {
              kind: 'error',
              value: previous.key === key ? previous.resource.value : empty,
              message: outcome.message,
            },
      }))
    })
    return () => {
      current = false
    }
  }, [key, empty, fetchValue, attempt])
  const resource: ChildResource<T> = stored.key === key ? stored.resource : { kind: 'loading', value: empty }
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (update) => {
      setStored((previous) => {
        if (previous.key !== key) return previous
        const value =
          typeof update === 'function' ? (update as (value: T) => T)(previous.resource.value) : update
        return { key, resource: { ...previous.resource, value } }
      })
    },
    [key],
  )
  return { resource, retry, setValue }
}

export interface RunDetailData {
  mounted: { current: boolean }
  revisionScope: RevisionScope
  run: LoadState<RunSummary>
  setRun: Dispatch<SetStateAction<LoadState<RunSummary>>>
  revisions: readonly RevisionSummary[]
  revisionsState: ChildResource<readonly RevisionSummary[]>
  retryRevisions: () => void
  selectedRevisionId: string | null
  setSelectedRevisionId: Dispatch<SetStateAction<string | null>>
  metrics: RunMetrics | null
  metricsState: ChildResource<RunMetrics | null>
  retryMetrics: () => void
  posters: readonly PosterFigure[]
  postersState: ChildResource<readonly PosterFigure[]>
  retryPosters: () => void
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
  const [selection, setSelection] = useState<{ runId: string; id: string | null }>({ runId, id: null })
  const selectedRevisionId = selection.runId === runId ? selection.id : null
  const setSelectedRevisionId: Dispatch<SetStateAction<string | null>> = useCallback(
    (update) => {
      setSelection((previous) => ({
        runId,
        id: typeof update === 'function' ? update(previous.runId === runId ? previous.id : null) : update,
      }))
    },
    [runId],
  )
  const [replay, storeReplay] = useState<ReplayState>({ kind: 'idle' })
  const [source, setSource] = useState<SourceState>({ kind: 'unknown' })
  const scope = useMemo<RevisionScope>(
    () => ({ revisionId: selectedRevisionId, current: true, runId, sessionStatus }),
    [selectedRevisionId, runId, sessionStatus],
  )
  const liveScope = useRef(scope)
  useEffect(() => {
    liveScope.current = scope
    scope.current = true
    storeReplay({ kind: 'idle' })
    return () => {
      scope.current = false
      scope.onInvalidate?.()
    }
  }, [scope])
  // Dispatches are tied to the selection that created them, including custom poster callbacks.
  const setReplay: Dispatch<SetStateAction<ReplayState>> = useCallback(
    (update) => {
      if (mounted.current && scope.current) storeReplay(update)
    },
    [mounted, scope],
  )

  const revisions = useChildResource(
    sessionStatus === 'signed-in' && runId !== '' ? runId : null,
    NO_REVISIONS,
    fetchRevisions,
  )
  const metrics = useChildResource(
    sessionStatus === 'signed-in' ? selectedRevisionId : null,
    null,
    fetchMetrics,
  )
  const posters = useChildResource(
    sessionStatus === 'signed-in' ? selectedRevisionId : null,
    NO_POSTERS,
    fetchPosters,
  )
  const writePosters = posters.setValue
  const setPosters: Dispatch<SetStateAction<readonly PosterFigure[]>> = useCallback(
    (update) => {
      if (mounted.current && scope.current) writePosters(update)
    },
    [mounted, scope, writePosters],
  )

  useEffect(() => {
    if (sessionStatus !== 'signed-in' || runId === '') return
    let current = true
    setRun({ kind: 'loading' })
    setSource({ kind: 'unknown' })
    void fetchRun(runId).then((outcome) => {
      if (current) setRun(runLoadOutcome(outcome))
    })
    return () => {
      current = false
    }
  }, [sessionStatus, runId])
  useEffect(() => {
    if (revisions.resource.kind !== 'ready') return
    const rows = revisions.resource.value
    setSelectedRevisionId((id) =>
      rows.some((row) => row.id === id) ? id : (latestRevision(rows)?.id ?? null),
    )
  }, [revisions.resource, setSelectedRevisionId])

  return {
    mounted,
    revisionScope: scope,
    run,
    setRun,
    revisions: revisions.resource.value,
    revisionsState: revisions.resource,
    retryRevisions: revisions.retry,
    selectedRevisionId,
    setSelectedRevisionId,
    metrics: metrics.resource.value,
    metricsState: metrics.resource,
    retryMetrics: metrics.retry,
    posters: posters.resource.value,
    postersState: posters.resource,
    retryPosters: posters.retry,
    setPosters,
    replay:
      liveScope.current !== scope
        ? { kind: 'idle' }
        : replay.kind === 'ready'
          ? { ...replay, scope }
          : replay,
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
  scope?: RevisionScope,
): Promise<void> {
  if (!mounted.current || (scope !== undefined && (!scope.current || scope.revisionId !== revision.id)))
    return
  const requestId = Symbol(revision.id)
  setReplay({ kind: 'loading', requestId })
  const publish = (next: ReplayState) => {
    if (!mounted.current || scope?.current === false) return
    setReplay((current) => (current.kind === 'loading' && current.requestId === requestId ? next : current))
  }
  const outcome = await fetchSnapshotBytes(revision.id)
  if (!mounted.current) return
  if (!outcome.ok) {
    publish({ kind: 'error', message: snapshotErrorMessage(outcome) })
    return
  }
  try {
    const snapshot = await decodeSnapshotBytes(outcome.value)
    if (!mounted.current) return
    publish({ kind: 'ready', revisionId: revision.id, replay: replayFromSnapshot(snapshot) })
  } catch (error) {
    if (!mounted.current) return
    publish({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
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
    revisionScope?: RevisionScope
    run: LoadState<RunSummary>
    notify: Notify
    setBusy: Dispatch<SetStateAction<boolean>>
    setAutoPosterStatus: Dispatch<SetStateAction<PosterStatus>>
    setPosters: Dispatch<SetStateAction<readonly PosterFigure[]>>
  },
  posterId: string | null,
): Promise<void> {
  if (deps.replay.kind !== 'ready' || deps.run.kind !== 'ready') return
  const scope = deps.revisionScope ?? deps.replay.scope
  if (
    !deps.mounted.current ||
    (scope !== undefined && (!scope.current || scope.revisionId !== deps.replay.revisionId))
  )
    return
  const context: PosterContext = {
    revisionId: deps.replay.revisionId,
    runCode: deps.run.value.runCode,
    dataset: deps.replay.replay.dataset,
  }
  deps.setBusy(true)
  const controller = new AbortController()
  if (scope !== undefined)
    scope.onInvalidate = () => {
      controller.abort()
      if (deps.mounted.current) {
        deps.setBusy(false)
        deps.setAutoPosterStatus({ kind: 'unavailable' })
      }
    }
  const publishStatus: Dispatch<SetStateAction<PosterStatus>> = (status) => {
    if (deps.mounted.current && scope?.current !== false) deps.setAutoPosterStatus(status)
  }
  const outcome =
    posterId === null
      ? await generateAutoPoster(context, publishStatus, controller.signal)
      : await retryAutoPoster(context, posterId, publishStatus, controller.signal)
  if (!deps.mounted.current) return
  if (scope?.current === false) return
  if (scope !== undefined) delete scope.onInvalidate
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
