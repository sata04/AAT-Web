/**
 * The analyzer's cloud lane: storing a finished analysis, requesting the
 * automatic poster, and deciding which dataset the retry control talks
 * about. All of it is optional by design — signed out, offline or deployed
 * with no Worker, the analyzer above these lines still runs.
 */

import { type AnalysisConfig, parseRunFilename } from '@aat/shared'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import type { Dataset } from '../app/dataset.ts'
import type { CloudOutcome } from '../cloud/gateway.ts'
import type { CloudStatuses, PosterStatus } from '../cloud/status.ts'
import { type CloudSyncResult, syncDataset } from '../cloud/sync.ts'
import { localPosterRevisionId, type PosterEntry } from '../poster/entry.ts'
import { generateAutoPoster, type PosterContext, type PosterRequestOutcome } from '../poster/requests.ts'

interface CloudSyncDeps {
  /** Serializes the lanes: a stale completion must not overwrite a newer sync. */
  syncGeneration: { current: number }
  posterPoll: { current: AbortController | null }
  setStatuses: Dispatch<SetStateAction<CloudStatuses>>
  setCloudSubject: Dispatch<SetStateAction<string | null>>
  setSyncedPoster: Dispatch<SetStateAction<PosterContext | null>>
  startAutoPoster: (context: PosterContext) => Promise<void>
}

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
async function startAutoPosterFor(
  deps: Pick<CloudSyncDeps, 'posterPoll'>,
  setPosterStatus: (poster: PosterStatus) => void,
  context: PosterContext,
): Promise<void> {
  deps.posterPoll.current?.abort()
  const controller = new AbortController()
  deps.posterPoll.current = controller
  const outcome = await generateAutoPoster(context, setPosterStatus, controller.signal)
  reportPosterOutcome(outcome, setPosterStatus)
}

function reportPosterOutcome(
  outcome: PosterRequestOutcome,
  setPosterStatus: (poster: PosterStatus) => void,
): void {
  if (!outcome.ok && outcome.kind === 'spec') {
    // The spec could not be built, so nothing was sent. Retrying identical
    // inputs would fail identically, which is why this one is not retryable.
    setPosterStatus({ kind: 'failed', message: outcome.advice.message, retryable: false })
  }
}

function reportSyncFailure(
  outcome: Extract<CloudOutcome<CloudSyncResult>, { ok: false }>,
  deps: Pick<CloudSyncDeps, 'setStatuses'>,
): void {
  deps.setStatuses((current) => ({
    ...current,
    sync: {
      kind: 'failed',
      message: outcome.message,
      // An unreachable cloud is always worth retrying — it is usually a
      // network that came back.
      retryable: outcome.kind === 'unavailable' || outcome.retryable,
    },
  }))
}

/**
 * Store a finished analysis in the cloud, then start the poster lane.
 *
 * `cloudSubject` moves with every attempt — not only on success — because a
 * failure for a different file is exactly when an unlabeled lane would
 * mislead, and because it is the name the retry control must resolve.
 */
async function syncToCloudFor(
  deps: CloudSyncDeps,
  dataset: Dataset,
  analysedWith?: AnalysisConfig,
): Promise<void> {
  const generation = ++deps.syncGeneration.current
  deps.setCloudSubject(dataset.name)
  // The new generation supersedes the poster lane too: an older file's poll
  // would keep writing statuses that now render under this file's name.
  deps.posterPoll.current?.abort()
  deps.posterPoll.current = null
  deps.setSyncedPoster(null)
  deps.setStatuses((current) => ({
    ...current,
    sync: { kind: 'saving' },
    poster: { kind: 'unavailable' },
  }))
  const outcome = await syncDataset(dataset, analysedWith ?? dataset.config)
  // A newer sync started while this one was in flight: the lanes describe whichever sync
  // started last, so a stale completion must not overwrite them (or the saved/poster state)
  // with the older file's result.
  if (generation !== deps.syncGeneration.current) return
  if (!outcome.ok) {
    reportSyncFailure(outcome, deps)
    return
  }
  const { revisionId, runCode } = outcome.value
  const context: PosterContext = { revisionId, runCode, dataset }
  deps.setSyncedPoster(context)
  deps.setStatuses((current) => ({
    ...current,
    sync: { kind: 'saved', revisionId, at: Date.now() },
    poster: { kind: 'loading' },
  }))

  // Poster generation is a separate lane on purpose: it can be slow, it can
  // fail, and neither outcome touches the analysis the user already has.
  await deps.startAutoPoster(context)
}

export interface CloudSyncLane {
  cloudSubject: string | null
  syncedPoster: PosterContext | null
  syncToCloud: (dataset: Dataset, analysedWith?: AnalysisConfig) => Promise<void>
  startAutoPoster: (context: PosterContext) => Promise<void>
}

export function useCloudSync(setStatuses: Dispatch<SetStateAction<CloudStatuses>>): CloudSyncLane {
  const [cloudSubject, setCloudSubject] = useState<string | null>(null)
  // The revision the poster figures of the last synced dataset hang from.
  // Null until an analysis has been stored, which is most of the time:
  // local-first.
  const [syncedPoster, setSyncedPoster] = useState<PosterContext | null>(null)
  const syncGeneration = useRef(0)
  // Aborts a superseded poster request's status writes when the screen goes
  // away or a newer request starts. The render itself is local work —
  // abandoning it stops nothing expensive; the guard exists so a stale request
  // cannot keep writing to the lane.
  const posterPoll = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      posterPoll.current?.abort()
    },
    [],
  )

  const setPosterStatus = useCallback(
    (poster: PosterStatus) => setStatuses((current) => ({ ...current, poster })),
    [setStatuses],
  )

  const startAutoPoster = useCallback(
    (context: PosterContext) => startAutoPosterFor({ posterPoll }, setPosterStatus, context),
    [setPosterStatus],
  )
  const syncToCloud = useCallback(
    (dataset: Dataset, analysedWith?: AnalysisConfig) =>
      syncToCloudFor(
        { syncGeneration, posterPoll, setStatuses, setCloudSubject, setSyncedPoster, startAutoPoster },
        dataset,
        analysedWith,
      ),
    [setStatuses, startAutoPoster],
  )

  return { cloudSubject, syncedPoster, syncToCloud, startAutoPoster }
}

/**
 * The context a poster is drawn under for the file on screen.
 *
 * A synced dataset draws (and, cloud willing, stores) against its revision;
 * an unsynced or unsigned-in one still gets a context, because the figure is
 * rendered locally — it just files nothing server-side. The only dataset that
 * gets no poster is one whose filename cannot yield a run code: the run code
 * is the figure's identity, and inventing one would misname a formal output.
 */
export function posterContextFor(
  syncedPoster: PosterContext | null,
  active: Dataset | null,
): PosterContext | null {
  if (active === null) return null
  if (syncedPoster !== null && syncedPoster.dataset.name === active.name) return syncedPoster
  const runCode = parseRunFilename(active.filename).runCode
  if (runCode === null) return null
  return { revisionId: null, runCode, dataset: active }
}

export function posterUnavailableReasonFor(posterContext: PosterContext | null): string | null {
  if (posterContext !== null) return null
  return (
    'ファイル名からラン番号を読み取れないため、ポスター図は作成できません。' +
    'YYMMDD_data.csv（同じ日に複数回行った場合は YYMMDDa_data.csv）の形式で保存し直してください。'
  )
}

export function activePostersFor(
  customPosters: readonly PosterEntry[],
  posterContext: PosterContext | null,
): PosterEntry[] {
  if (posterContext === null) return []
  // Unsigned-in renders are filed under `local:<runCode>`, not one shared 'local' —
  // two different experiments must not show each other's figures.
  const revisionId = posterContext.revisionId ?? localPosterRevisionId(posterContext.runCode)
  return customPosters.filter((poster) => poster.analysisRevisionId === revisionId)
}

/**
 * Retry the automatic poster.
 *
 * There is no remote render to re-attempt: a retry is the same local render
 * plus upload the first attempt was, and the upload endpoint's unique index
 * makes a repeat safe — an already-stored figure is read back, not drawn twice.
 */
export function retryPosterFor(
  syncedPoster: PosterContext | null,
  startAutoPoster: (context: PosterContext) => Promise<void>,
): void {
  if (syncedPoster === null) return
  void startAutoPoster(syncedPoster)
}

/**
 * Retry the failed sync for the file the lane names.
 *
 * `cloudSubject` records which file the last sync attempt described, so the
 * retry must re-sync *that* file — syncing whatever is on screen after a
 * dataset switch would perform a different operation than the labeled
 * failure. If the subject was closed, the stale failure is dropped instead.
 */
export function retrySyncFor(deps: {
  datasets: readonly Dataset[]
  cloudSubject: string | null
  setStatuses: Dispatch<SetStateAction<CloudStatuses>>
  syncToCloud: (dataset: Dataset, analysedWith?: AnalysisConfig) => Promise<void>
}): void {
  const subject = deps.datasets.find((dataset) => dataset.name === deps.cloudSubject)
  if (subject === undefined) {
    deps.setStatuses((current) =>
      current.sync.kind === 'failed' ? { ...current, sync: { kind: 'local-only' } } : current,
    )
    return
  }
  void deps.syncToCloud(subject)
}
