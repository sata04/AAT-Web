/**
 * The analyzer loop's two invariants that only break under concurrency.
 *
 * One is the cancellation epoch: it must be re-checked after *every* await in
 * the open loop, because a cancel that lands while `file.arrayBuffer()` is in
 * flight used to still install the file under the fresh epoch. The other is
 * keyed-by-content-hash bookkeeping: two datasets opened from identical bytes
 * share one `sourceFiles` entry and one retained worker table, so closing
 * either must not release what the sibling still needs. `retrySyncFor` rounds
 * it out: the retry must talk to the dataset the failure named.
 */

import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { describe, expect, it, vi } from 'vitest'
import type { AnalysisClient, AnalysisProgress } from '../../src/analysis/client.ts'
import type { AnalysisPayload, OpenedSource } from '../../src/analysis/protocol.ts'
import type { Dataset } from '../../src/app/dataset.ts'
import { type CloudStatuses, INITIAL_STATUSES } from '../../src/cloud/status.ts'
import { TourDatasets } from '../../src/onboarding/tour-datasets.ts'
import { retrySyncFor } from '../../src/screens/analyzer-cloud.ts'
import {
  type AnalyzerLoopDeps,
  closeDatasetFor,
  closeTourDatasetFor,
  openFilesFor,
} from '../../src/screens/analyzer-loop.ts'

const SHA = 'a'.repeat(64)

/**
 * Only the identity fields are ever read by the code under test — name,
 * filename and the content hash. The rest of a `Dataset` is worker output.
 */
function dataset(filename: string, sourceSha256 = SHA): Dataset {
  return { name: filename.replace(/\.csv$/, ''), filename, sourceSha256 } as unknown as Dataset
}

function openedSource(filename: string): OpenedSource {
  return {
    sourceSha256: SHA,
    filename,
    encoding: 'utf-8',
    columnNames: ['t', 'a'],
    detected: { time: ['t'], acceleration: ['a'] },
    rowCount: 1,
    suggestedMapping: null,
    ambiguity: 'MULTIPLE_CANDIDATES',
  }
}

function stubClient(overrides: Partial<AnalysisClient> = {}): AnalysisClient {
  return {
    open: vi.fn(async () => openedSource('run-a.csv')),
    analyse: vi.fn(async () => ({ payload: null, fromCache: false })),
    release: vi.fn(async () => {}),
    cancelPending: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  } as unknown as AnalysisClient
}

/** A tiny set-state that applies functional updates against a box — what React does. */
function stateful<T>(initial: T): {
  current: T
  set: (next: T | ((current: T) => T)) => void
} {
  const box = { current: initial }
  return {
    get current() {
      return box.current
    },
    set current(value: T) {
      box.current = value
    },
    set: (next) => {
      box.current = typeof next === 'function' ? (next as (current: T) => T)(box.current) : next
    },
  }
}

function loopDeps(client: AnalysisClient, overrides: Partial<AnalyzerLoopDeps> = {}) {
  const statuses = stateful<CloudStatuses>(INITIAL_STATUSES)
  const datasetsBox = stateful<Dataset[]>([])
  const deps: AnalyzerLoopDeps = {
    getAnalysisClient: () => client,
    analysisClient: { current: client },
    config: DEFAULT_ANALYSIS_CONFIG,
    signedIn: false,
    datasets: datasetsBox.current,
    activeName: null,
    cloudSubject: null,
    pendingColumns: null,
    notify: vi.fn(),
    syncToCloud: vi.fn(async () => {}),
    setStatuses: statuses.set,
    setDatasets: datasetsBox.set,
    setActiveName: vi.fn(),
    setSelection: vi.fn(),
    setViewport: vi.fn(),
    setConfig: vi.fn(),
    setSettingsOpen: vi.fn(),
    setPendingColumns: vi.fn(),
    sourceFiles: { current: new Map<string, File>() },
    closedSources: { current: new Set<string>() },
    pendingFileQueue: { current: [] },
    cancelEpoch: { current: 0 },
    datasetsRef: { current: datasetsBox.current },
    ...overrides,
  }
  return { deps, statuses, datasetsBox }
}

describe('openFilesFor epoch checks', () => {
  it('drops a file whose byte read finishes after the user cancelled', async () => {
    const client = stubClient()
    const { deps, datasetsBox } = loopDeps(client)

    const file = new File([new Uint8Array([1])], 'run-a.csv')
    // The read resolves only after the cancel lands — the in-flight file must
    // not go on to claim a worker request under the fresh epoch.
    file.arrayBuffer = async () => {
      deps.cancelEpoch.current += 1
      return new Uint8Array([1]).buffer
    }

    await openFilesFor(deps, [file])

    expect(client.open).not.toHaveBeenCalled()
    expect(client.analyse).not.toHaveBeenCalled()
    expect(deps.sourceFiles.current.size).toBe(0)
    expect(datasetsBox.current).toHaveLength(0)
  })

  it('ignores open progress reported after a cancel, and drops the opened file', async () => {
    let reportProgress: ((progress: AnalysisProgress) => void) | undefined
    let resolveOpen: ((source: OpenedSource) => void) | undefined
    const client = stubClient({
      open: vi.fn(
        (_name: string, _bytes: ArrayBuffer, onProgress?: (progress: AnalysisProgress) => void) =>
          new Promise<OpenedSource>((resolve) => {
            reportProgress = onProgress
            resolveOpen = resolve
          }),
      ),
    })
    const { deps, statuses, datasetsBox } = loopDeps(client)

    const opening = openFilesFor(deps, [new File([new Uint8Array([1])], 'run-a.csv')])
    deps.cancelEpoch.current += 1
    reportProgress?.({ stage: 'decoding', percent: 50 })

    // The loop's own 'decoding 0%' write stands; the stale progress report is gated off.
    expect(statuses.current.analysis).toEqual({ kind: 'running', stage: 'decoding', percent: 0 })

    resolveOpen?.(openedSource('run-a.csv'))
    await opening

    expect(client.analyse).not.toHaveBeenCalled()
    expect(datasetsBox.current).toHaveLength(0)
  })
})

/** Minimal real worker payload: install still crosses datasetFromPayload. */
function payload(filename: string): AnalysisPayload {
  const sensor = {
    present: false,
    time: new Float64Array(),
    gravity: new Float64Array(),
    acceleration: new Float64Array(),
    filteredTime: new Float64Array(),
    filteredGravity: new Float64Array(),
    startIndex: null,
    endIndex: null,
  }
  return {
    ...openedSource(filename),
    mapping: { timeColumn: 't', innerColumn: 'a', dragColumn: 'a', useInner: true, useDrag: false },
    inner: sensor,
    drag: sensor,
    sync: {
      innerIndex: null,
      dragIndex: null,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 0,
      dragCandidateCount: 0,
    },
    filterEndIndex: -1,
    statistics: {
      inner: { mean: null, startTime: null, std: null },
      drag: { mean: null, startTime: null, std: null },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: 0,
    analysisTimestamp: '2026-10-30T00:00:00.000Z',
  }
}

describe('request-specific tour installs', () => {
  function analyzingClient(filename: string, sourceSha256 = SHA) {
    const result = { ...payload(filename), sourceSha256 }
    return stubClient({
      open: vi.fn(async () => ({
        ...openedSource(filename),
        sourceSha256,
        suggestedMapping: result.mapping,
      })),
      analyse: vi.fn(async () => ({ payload: result, fromCache: true })),
    })
  }

  it('gives the owner the exact cached fallback object before its install is dispatched', async () => {
    const client = analyzingClient('sample-a-tour.csv')
    const queued: ((current: Dataset[]) => Dataset[])[] = []
    const { deps } = loopDeps(client, {
      signedIn: true,
      setDatasets: (update) => {
        expect(typeof update).toBe('function')
        queued.push(update as (current: Dataset[]) => Dataset[])
      },
    })
    let owned: Dataset | undefined
    const acceptInstall = vi.fn((installed: Dataset) => {
      expect(queued).toHaveLength(0)
      owned = installed
      return true
    })

    await openFilesFor(deps, [new File(['data'], 'sample-a-tour.csv')], {
      localOnly: true,
      acceptInstall,
    })

    expect(acceptInstall).toHaveBeenCalledOnce()
    expect(queued).toHaveLength(1)
    expect(queued[0]?.([])[0]).toBe(owned)
    expect(owned?.filename).toBe('sample-a-tour.csv')
    expect(owned?.fromCache).toBe(true)
    expect(deps.syncToCloud).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'drops an exited tour without disturbing a surviving source: sibling=%s',
    async (sibling) => {
      const client = analyzingClient('sample-a-tour.csv')
      const { deps, datasetsBox, statuses } = loopDeps(client, { signedIn: true })
      const kept = dataset('sample-a.csv')
      deps.datasetsRef.current = sibling ? [kept] : []

      await openFilesFor(deps, [new File(['data'], 'sample-a-tour.csv')], {
        localOnly: true,
        acceptInstall: () => false,
      })

      expect(datasetsBox.current).toEqual([])
      expect(deps.setActiveName).not.toHaveBeenCalled()
      expect(deps.syncToCloud).not.toHaveBeenCalled()
      expect(statuses.current.analysis).toEqual({ kind: 'ready', fromCache: true })
      expect(client.release).not.toHaveBeenCalled()
      expect(deps.sourceFiles.current.has(SHA)).toBe(true)
    },
  )

  it('preserves a shared source whose kept dataset install has not committed yet', async () => {
    const keptClient = analyzingClient('sample-a.csv')
    const queued: ((current: Dataset[]) => Dataset[])[] = []
    const { deps } = loopDeps(keptClient, {
      setDatasets: (update) => queued.push(update as (current: Dataset[]) => Dataset[]),
    })
    await openFilesFor(deps, [new File(['same bytes'], 'sample-a.csv')], { localOnly: true })
    expect(deps.datasetsRef.current).toEqual([])
    expect(queued).toHaveLength(1)

    const replayClient = analyzingClient('sample-a-tour.csv')
    deps.getAnalysisClient = () => replayClient
    await openFilesFor(deps, [new File(['same bytes'], 'sample-a-tour.csv')], {
      localOnly: true,
      acceptInstall: () => false,
    })

    expect(queued).toHaveLength(1)
    expect(queued[0]?.([])[0]?.filename).toBe('sample-a.csv')
    expect(replayClient.release).not.toHaveBeenCalled()
    expect(await deps.sourceFiles.current.get(SHA)?.text()).toBe('same bytes')
  })

  describe('accepted pending tour cleanup', () => {
    function queuedLoop(client: AnalysisClient) {
      const queued: ((current: Dataset[]) => Dataset[])[] = []
      const result = loopDeps(client, {
        setDatasets: (update) => queued.push(update as (current: Dataset[]) => Dataset[]),
      })
      return {
        ...result,
        tracker: new TourDatasets(),
        commit: () => queued.reduce((current, update) => update(current), [] as Dataset[]),
      }
    }

    it('preserves the shared recovery source when the kept sibling is still queued', async () => {
      const keptClient = analyzingClient('sample-a.csv')
      const { deps, tracker, commit } = queuedLoop(keptClient)
      const keptRequest = tracker.open('a', [])
      await openFilesFor(deps, [new File(['same bytes'], keptRequest.filename)], {
        localOnly: true,
        acceptInstall: keptRequest.acceptInstall,
      })
      keptRequest.settle()
      tracker.finish('keep')

      const replay = tracker.open('a', [])
      const replayClient = analyzingClient(replay.filename)
      deps.getAnalysisClient = () => replayClient
      await openFilesFor(deps, [new File(['same bytes'], replay.filename)], {
        localOnly: true,
        acceptInstall: replay.acceptInstall,
      })
      replay.settle()
      tracker.discardPending()
      tracker.close([], [], (owned) => closeTourDatasetFor(deps, owned))
      tracker.finish('skip')

      expect(commit().map((installed) => installed.filename)).toEqual(['sample-a.csv'])
      expect(await deps.sourceFiles.current.get(SHA)?.text()).toBe('same bytes')
      expect(replayClient.release).not.toHaveBeenCalled()
      expect(deps.closedSources.current.size).toBe(0)
    })

    it('removes the owned object while preserving a newer same-name user install queued before cleanup', async () => {
      const demoClient = analyzingClient('sample-a.csv')
      const { deps, tracker, commit } = queuedLoop(demoClient)
      const demo = tracker.open('a', [])
      await openFilesFor(deps, [new File(['demo'], demo.filename)], {
        localOnly: true,
        acceptInstall: demo.acceptInstall,
      })
      demo.settle()

      // A user import started before the tour may finish after its sample.
      const userClient = analyzingClient('sample-a.csv', 'b'.repeat(64))
      deps.getAnalysisClient = () => userClient
      await openFilesFor(deps, [new File(['user'], 'sample-a.csv')])
      const user = commit()[0]
      expect(user).toBeDefined()
      const activeWrites = vi.mocked(deps.setActiveName).mock.calls.length
      const selectionWrites = vi.mocked(deps.setSelection).mock.calls.length
      const viewportWrites = vi.mocked(deps.setViewport).mock.calls.length
      tracker.discardPending()
      tracker.close([], [], (owned) => closeTourDatasetFor(deps, owned))
      tracker.finish('skip')

      expect(commit()).toEqual([user])
      expect(deps.setActiveName).toHaveBeenCalledTimes(activeWrites)
      expect(deps.setSelection).toHaveBeenCalledTimes(selectionWrites)
      expect(deps.setViewport).toHaveBeenCalledTimes(viewportWrites)
      expect(deps.closedSources.current.size).toBe(0)
      expect(await deps.sourceFiles.current.get('b'.repeat(64))?.text()).toBe('user')
    })

    it('does not cancel a pre-tour user import that finishes after owned cleanup', async () => {
      const userResult = { ...payload('sample-a.csv'), sourceSha256: 'b'.repeat(64) }
      let finishUser: ((result: { payload: AnalysisPayload; fromCache: boolean }) => void) | undefined
      let analysisStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        analysisStarted = resolve
      })
      const userClient = stubClient({
        open: vi.fn(async () => ({
          ...openedSource('sample-a.csv'),
          sourceSha256: userResult.sourceSha256,
          suggestedMapping: userResult.mapping,
        })),
        analyse: vi.fn(
          () =>
            new Promise<{ payload: AnalysisPayload; fromCache: boolean }>((resolve) => {
              finishUser = resolve
              analysisStarted?.()
            }),
        ),
      })
      const { deps, tracker, commit } = queuedLoop(userClient)
      const userOpening = openFilesFor(deps, [new File(['user'], 'sample-a.csv')])
      await started

      const demo = tracker.open('a', [])
      const demoClient = analyzingClient(demo.filename)
      deps.getAnalysisClient = () => demoClient
      await openFilesFor(deps, [new File(['demo'], demo.filename)], {
        localOnly: true,
        acceptInstall: demo.acceptInstall,
      })
      demo.settle()
      tracker.discardPending()
      tracker.close([], [], (owned) => closeTourDatasetFor(deps, owned))
      tracker.finish('skip')
      const markerAfterClose = deps.closedSources.current.has('sample-a.csv')
      finishUser?.({ payload: userResult, fromCache: false })
      await userOpening

      expect(markerAfterClose).toBe(false)
      expect(commit()).toHaveLength(1)
      expect(commit()[0]?.fromCache).toBe(false)
      expect(userClient.release).not.toHaveBeenCalled()
      expect(await deps.sourceFiles.current.get(userResult.sourceSha256)?.text()).toBe('user')
    })
  })

  it('keeps the ordinary signed-in file path and cloud sync unchanged', async () => {
    const client = analyzingClient('run-a.csv')
    const { deps, datasetsBox } = loopDeps(client, { signedIn: true })
    await openFilesFor(deps, [new File(['data'], 'run-a.csv')])
    expect(datasetsBox.current).toHaveLength(1)
    expect(deps.setActiveName).toHaveBeenCalledWith('run-a')
    expect(deps.syncToCloud).toHaveBeenCalledWith(datasetsBox.current[0])
    expect(client.analyse).toHaveBeenCalledOnce()
  })
})

describe('closeDatasetFor with identical bytes', () => {
  it('keeps the shared source entry while a sibling dataset stays open', () => {
    const a = dataset('run-a.csv')
    const b = dataset('run-b.csv')
    const client = stubClient()
    const { deps } = loopDeps(client, { datasets: [a, b], activeName: 'run-b' })
    deps.datasetsRef.current = [a, b]
    deps.sourceFiles.current.set(SHA, new File([new Uint8Array([1])], 'run-a.csv'))

    closeDatasetFor(deps, a)

    expect(deps.sourceFiles.current.has(SHA)).toBe(true)
    expect(client.release).not.toHaveBeenCalled()
    // The marker is per-filename: the surviving sibling's results must still land.
    expect(deps.closedSources.current.has('run-a.csv')).toBe(true)
    expect(deps.closedSources.current.has('run-b.csv')).toBe(false)
  })

  it('releases the retained table only when the last sibling closes', () => {
    const a = dataset('run-a.csv')
    const b = dataset('run-b.csv')
    const client = stubClient()
    const { deps } = loopDeps(client, { datasets: [b], activeName: 'run-b' })
    deps.sourceFiles.current.set(SHA, new File([new Uint8Array([1])], 'run-a.csv'))

    closeDatasetFor(deps, a)
    expect(client.release).not.toHaveBeenCalled()

    deps.datasets = []
    deps.activeName = null
    closeDatasetFor(deps, b)

    expect(deps.sourceFiles.current.has(SHA)).toBe(false)
    expect(client.release).toHaveBeenCalledWith(SHA)
  })
})

describe('retrySyncFor', () => {
  it('re-syncs the dataset the failure named rather than whichever is active', () => {
    const a = dataset('run-a.csv')
    const b = dataset('run-b.csv', 'b'.repeat(64))
    const syncToCloud = vi.fn(async () => {})

    retrySyncFor({
      datasets: [a, b],
      cloudSubject: 'run-b',
      setStatuses: vi.fn(),
      syncToCloud,
    })

    expect(syncToCloud).toHaveBeenCalledWith(b)
  })

  it('clears the stale failure lane when the named dataset was closed', () => {
    const statuses = stateful<CloudStatuses>({
      ...INITIAL_STATUSES,
      sync: { kind: 'failed', message: 'x', retryable: true },
    })
    const syncToCloud = vi.fn(async () => {})

    retrySyncFor({
      datasets: [],
      cloudSubject: 'run-a',
      setStatuses: statuses.set,
      syncToCloud,
    })

    expect(syncToCloud).not.toHaveBeenCalled()
    expect(statuses.current.sync.kind).toBe('local-only')
  })
})
