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
import { type AnalysisClient, type AnalysisProgress, AnalysisWorkerError } from '../../src/analysis/client.ts'
import type { AnalysisPayload, ColumnMapping, OpenedSource } from '../../src/analysis/protocol.ts'
import { type Dataset, openedSourceForDataset } from '../../src/app/dataset.ts'
import { type CloudStatuses, INITIAL_STATUSES } from '../../src/cloud/status.ts'
import { retrySyncFor } from '../../src/screens/analyzer-cloud.ts'
import {
  type AnalyzerLoopDeps,
  cancelAnalysisFor,
  cancelPendingColumnsFor,
  closeDatasetFor,
  confirmPendingColumnsFor,
  openFilesFor,
  reconcileCloudFor,
  runAnalysisFor,
} from '../../src/screens/analyzer-loop.ts'

const SHA = 'a'.repeat(64)

/**
 * Only the identity fields are ever read by the code under test — name,
 * filename and the content hash. The rest of a `Dataset` is worker output.
 */
function dataset(filename: string, sourceSha256 = SHA): Dataset {
  return { name: filename.replace(/\.csv$/, ''), filename, sourceSha256 } as unknown as Dataset
}

function openedSource(filename: string, sourceSha256 = SHA): OpenedSource {
  return {
    sourceSha256,
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
    mounted: { current: true },
    requests: { current: new Map() },
    imports: { current: new WeakMap() },
    releaseCandidates: { current: new Set() },
    syncRequested: { current: new WeakSet() },
    syncRequestedUser: { current: null },
    getAnalysisClient: () => client,
    analysisClient: { current: client },
    config: DEFAULT_ANALYSIS_CONFIG,
    signedIn: false,
    sessionUserId: null,
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
    setPendingColumns: vi.fn((next) => {
      deps.pendingColumns = typeof next === 'function' ? next(deps.pendingColumns) : next
    }),
    sourceFiles: { current: new Map<string, File>() },
    closedSources: { current: new Set<string>() },
    pendingFileQueue: { current: [] },
    cancelEpoch: { current: 0 },
    datasetsRef: { current: overrides.datasets ?? datasetsBox.current },
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const mapping: ColumnMapping = {
  timeColumn: 't',
  innerColumn: 'a',
  dragColumn: 'a',
  useInner: true,
  useDrag: false,
}
function result(
  filename = 'run-a.csv',
  selected = mapping,
  sourceSha256 = SHA,
): Awaited<ReturnType<AnalysisClient['analyse']>> {
  const series = {
    present: true,
    time: new Float64Array([0]),
    gravity: new Float64Array([1]),
    filteredTime: new Float64Array([0]),
    filteredGravity: new Float64Array([1]),
    acceleration: new Float64Array([9.8]),
    startIndex: 0,
    endIndex: 0,
  }
  return {
    fromCache: false,
    payload: {
      sourceSha256,
      filename,
      encoding: 'utf-8',
      columnNames: ['t', 'a', 'b'],
      detected: { time: ['t'], acceleration: ['a', 'b'] },
      mapping: selected,
      inner: series,
      drag: series,
      sync: {
        innerIndex: 0,
        dragIndex: 0,
        innerFallback: null,
        dragFallback: null,
        innerCandidateCount: 1,
        dragCandidateCount: 1,
      },
      filterEndIndex: 0,
      statistics: { inner: { mean: 1, startTime: 0, std: 0 }, drag: { mean: 1, startTime: 0, std: 0 } },
      gQuality: [],
      gQualityComputed: true,
      warnings: [],
      sampleCount: 1,
      analysisTimestamp: '2026-01-01T00:00:00Z',
    } satisfies AnalysisPayload,
  }
}
function commit(deps: AnalyzerLoopDeps, datasetsBox: { current: Dataset[] }) {
  deps.datasets = datasetsBox.current
  deps.datasetsRef.current = datasetsBox.current
  for (const dataset of datasetsBox.current) {
    const request = deps.imports.current.get(dataset)
    if (request !== undefined) request.installing = false
  }
}
function successfulClient() {
  return stubClient({
    open: vi.fn(async (name) => ({ ...openedSource(name), suggestedMapping: mapping })),
    analyse: vi.fn(async (input) => result(input.filename)),
  })
}

describe('analysis request identity', () => {
  it('keeps the newest mapping and ignores an older result and progress', async () => {
    const older = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const newer = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    let oldProgress: ((progress: AnalysisProgress) => void) | undefined
    const analyse = vi
      .fn<AnalysisClient['analyse']>()
      .mockImplementationOnce((_input, progress) => {
        oldProgress = progress
        return older.promise
      })
      .mockImplementationOnce(() => newer.promise)
    const { deps, statuses, datasetsBox } = loopDeps(stubClient({ analyse }), { signedIn: true })
    const a = runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    const selected = { ...mapping, innerColumn: 'b' }
    const b = runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping: selected })
    newer.resolve(result('run-a.csv', selected))
    await b
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    oldProgress?.({ stage: 'decoding', percent: 75 })
    older.resolve(result())
    await a
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(datasetsBox.current[0]?.mapping.innerColumn).toBe('b')
    expect(statuses.current.analysis.kind).toBe('ready')
    expect(deps.syncToCloud).toHaveBeenCalledTimes(1)
  })
  it('does not report an obsolete mapping failure', async () => {
    const older = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const analyse = vi
      .fn<AnalysisClient['analyse']>()
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValue(result())
    const { deps, statuses } = loopDeps(stubClient({ analyse }))
    const a = runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    await runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    older.reject(new Error('obsolete failure'))
    await a
    expect(statuses.current.analysis.kind).toBe('ready')
    expect(deps.notify).not.toHaveBeenCalled()
  })
  it('drops every pending completion after close, even if the first one is newest', async () => {
    const a = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const b = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const analyse = vi
      .fn<AnalysisClient['analyse']>()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise)
    const { deps, datasetsBox } = loopDeps(stubClient({ analyse }))
    await runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    commit(deps, datasetsBox)
    const first = runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    const second = runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    closeDatasetFor(deps, datasetsBox.current[0] as Dataset)
    b.resolve(result())
    await second
    a.resolve(result())
    await first
    expect(datasetsBox.current).toEqual([])
    expect(deps.closedSources.current.has('run-a.csv')).toBe(true)
  })
  it('closes newer analyses of the same import while preserving a subsequent real import', async () => {
    const { deps, datasetsBox } = loopDeps(successfulClient())
    await openFilesFor(deps, [new File(['first'], 'run-a.csv')])
    commit(deps, datasetsBox)
    const original = datasetsBox.current[0] as Dataset
    await runAnalysisFor(deps, { source: openedSource('run-a.csv'), mapping })
    commit(deps, datasetsBox)
    closeDatasetFor(deps, original)
    expect(datasetsBox.current).toEqual([])
    await openFilesFor(deps, [new File(['replacement'], 'run-a.csv')])
    commit(deps, datasetsBox)
    closeDatasetFor(deps, original)
    expect(datasetsBox.current).toHaveLength(1)
  })

  it('does not reopen the worker or read the next file after disposal', async () => {
    const read = deferred<ArrayBuffer>()
    const file = new File(['a'], 'run-a.csv')
    file.arrayBuffer = () => read.promise
    const next = new File(['b'], 'run-b.csv')
    const nextRead = vi.spyOn(next, 'arrayBuffer')
    const client = stubClient()
    const { deps } = loopDeps(client)
    const getClient = vi.fn(() => client)
    deps.getAnalysisClient = getClient
    const pending = openFilesFor(deps, [file, next])
    deps.mounted.current = false
    client.dispose()
    getClient.mockClear()
    read.resolve(new ArrayBuffer(1))
    await pending
    expect(client.open).not.toHaveBeenCalled()
    expect(getClient).not.toHaveBeenCalled()
    expect(nextRead).not.toHaveBeenCalled()
  })
})

describe('import ownership and cloud reconciliation', () => {
  it('keeps a displayed demo local while a real same-name file is still reading', async () => {
    const read = deferred<ArrayBuffer>()
    const client = successfulClient()
    const { deps, datasetsBox } = loopDeps(client, { signedIn: true })
    const demoId = Symbol('demo')
    await openFilesFor(deps, [new File(['demo'], 'sample-a.csv')], { importId: demoId, localOnly: true })
    commit(deps, datasetsBox)
    const demo = datasetsBox.current[0] as Dataset
    const real = new File(['real'], 'sample-a.csv')
    real.arrayBuffer = () => read.promise
    const realId = Symbol('real')
    const opening = openFilesFor(deps, [real], { importId: realId })
    const realRequest = [...deps.requests.current.values()].find((request) => request.importId === realId)
    vi.mocked(client.open).mockImplementationOnce(async (filename) => ({
      ...openedSource(filename, 'b'.repeat(64)),
      suggestedMapping: mapping,
    }))
    vi.mocked(client.analyse).mockImplementation(async (input) =>
      result(input.filename, input.mapping, input.sourceSha256),
    )

    await runAnalysisFor(deps, {
      source: openedSourceForDataset(demo),
      mapping: { ...mapping, innerColumn: 'b' },
    })
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(deps.imports.current.get(datasetsBox.current[0] as Dataset)).toMatchObject({
      importId: demoId,
      localOnly: true,
    })
    expect(realRequest?.pending).toBe(true)
    expect(deps.syncToCloud).not.toHaveBeenCalled()

    read.resolve(new ArrayBuffer(1))
    await opening
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(datasetsBox.current.map((dataset) => dataset.name)).toEqual(['sample-a', 'sample-a (2)'])
    expect(deps.imports.current.get(datasetsBox.current[1] as Dataset)).toMatchObject({
      importId: realId,
      localOnly: false,
    })
    expect(deps.syncToCloud).toHaveBeenCalledExactlyOnceWith(datasetsBox.current[1])
  })

  it('reserves distinct dataset names for colliding basenames within one batch', async () => {
    const read = deferred<ArrayBuffer>()
    const first = new File(['first'], 'same.csv')
    first.arrayBuffer = () => read.promise
    const client = successfulClient()
    const { deps, datasetsBox } = loopDeps(client)
    const opening = openFilesFor(deps, [
      first,
      new File(['second'], 'same.csv'),
      new File(['third'], 'same.txt'),
    ])
    expect([...deps.requests.current.values()].map((request) => request.filename)).toEqual([
      'same.csv',
      'same (2).csv',
      'same (3).txt',
    ])
    read.resolve(new ArrayBuffer(1))
    await opening
    expect(datasetsBox.current.map((dataset) => dataset.name)).toEqual(['same', 'same (2)', 'same (3)'])
    expect(
      new Set(datasetsBox.current.map((dataset) => deps.imports.current.get(dataset)?.sourceId)).size,
    ).toBe(3)
  })

  it('keeps the queued import token and local-only flag after cancelling a column dialog', async () => {
    const read = deferred<ArrayBuffer>()
    const queued = new File(['second demo'], 'queued.csv')
    queued.arrayBuffer = () => read.promise
    const client = successfulClient()
    vi.mocked(client.open).mockResolvedValueOnce(openedSource('ambiguous.csv'))
    const { deps, datasetsBox } = loopDeps(client, { signedIn: true })
    const importId = Symbol('tour batch')
    await openFilesFor(deps, [new File(['first demo'], 'ambiguous.csv'), queued], {
      importId,
      localOnly: true,
    })
    const request = deps.pendingFileQueue.current[0]?.request
    expect(request).toMatchObject({ importId, localOnly: true, pending: true })
    cancelPendingColumnsFor(deps)
    expect(deps.pendingFileQueue.current).toHaveLength(0)
    read.resolve(new ArrayBuffer(1))
    await vi.waitFor(() => expect(datasetsBox.current).toHaveLength(1))
    commit(deps, datasetsBox)
    expect(deps.imports.current.get(datasetsBox.current[0] as Dataset)).toBe(request)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).not.toHaveBeenCalled()
  })

  it('reserves the whole batch and records ownership by import ID even when names collide', async () => {
    const read = deferred<ArrayBuffer>()
    const real = new File(['real'], 'sample-a.csv')
    real.arrayBuffer = () => read.promise
    const client = successfulClient()
    const { deps, datasetsBox } = loopDeps(client)
    const opening = openFilesFor(deps, [real, new File(['later'], 'later.csv')])
    expect([...deps.requests.current.values()].map((request) => request.filename)).toEqual([
      'sample-a.csv',
      'later.csv',
    ])
    expect([...deps.requests.current.values()].every((request) => request.pending)).toBe(true)
    const tourId = Symbol('tour')
    await openFilesFor(deps, [new File(['demo'], 'sample-a.csv')], { importId: tourId, localOnly: true })
    read.resolve(new ArrayBuffer(1))
    await opening
    expect(deps.imports.current.get(datasetsBox.current[0] as Dataset)?.importId).toBe(tourId)
    // Both sources survive under distinct reserved names; the demo cannot replace the pending real file.
    expect(client.analyse).toHaveBeenCalledTimes(3)
    expect(datasetsBox.current.map((dataset) => dataset.filename)).toEqual([
      'sample-a (2).csv',
      'sample-a.csv',
      'later.csv',
    ])
    expect(deps.imports.current.get(datasetsBox.current[1] as Dataset)?.importId).not.toBe(tourId)
  })
  it('syncs local imports once after sign-in and keeps tour re-analyses local', async () => {
    const { deps, datasetsBox } = loopDeps(successfulClient())
    await openFilesFor(deps, [new File(['real'], '260811_data.csv')])
    await openFilesFor(deps, [new File(['demo'], 'sample-a.csv')], { localOnly: true })
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).not.toHaveBeenCalled()
    deps.signedIn = true
    reconcileCloudFor(deps)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(1)
    expect(deps.syncToCloud).toHaveBeenCalledWith(datasetsBox.current[0])
    await runAnalysisFor(deps, { source: openedSource('sample-a.csv'), mapping })
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(1)
  })
  it('re-syncs open datasets when a different account signs in', async () => {
    // The analyzer stays mounted across sign-out/sign-in: markers issued under
    // one account must not suppress the next account's revisions.
    const { deps, datasetsBox } = loopDeps(successfulClient())
    await openFilesFor(deps, [new File(['real'], '260811_data.csv')])
    commit(deps, datasetsBox)
    deps.signedIn = true
    deps.sessionUserId = 'alice'
    reconcileCloudFor(deps)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(1)
    deps.sessionUserId = 'bob'
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(2)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(2)
  })
  it('re-attempts a sync interrupted by sign-out when the same account signs back in', async () => {
    // A sync that dies mid-flight at sign-out fails under the old identity.
    // Signing back into that account must not inherit the marker — the dataset
    // would otherwise never reach the cloud until reopened.
    const { deps, datasetsBox } = loopDeps(successfulClient())
    await openFilesFor(deps, [new File(['real'], '260811_data.csv')])
    commit(deps, datasetsBox)
    deps.signedIn = true
    deps.sessionUserId = 'alice'
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(1)
    deps.signedIn = false
    deps.sessionUserId = null
    reconcileCloudFor(deps)
    deps.signedIn = true
    deps.sessionUserId = 'alice'
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(2)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).toHaveBeenCalledTimes(2)
  })
  it('preserves local-only ownership across a column dialog', async () => {
    const client = stubClient({ analyse: vi.fn(async () => result()) })
    const { deps, datasetsBox } = loopDeps(client, { signedIn: true })
    await openFilesFor(deps, [new File(['demo'], 'run-a.csv')], { localOnly: true })
    deps.pendingColumns = { source: openedSource('run-a.csv'), initial: mapping, reason: undefined }
    confirmPendingColumnsFor(deps, mapping)
    await vi.waitFor(() => expect(datasetsBox.current).toHaveLength(1))
    commit(deps, datasetsBox)
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).not.toHaveBeenCalled()
  })

  it('does not inherit a cancelled open when the same filename and bytes are opened again', async () => {
    const analysis = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const client = stubClient({ analyse: vi.fn(() => analysis.promise) })
    const { deps, datasetsBox } = loopDeps(client, { signedIn: true })
    await openFilesFor(deps, [new File(['same bytes'], 'run-a.csv')])
    cancelPendingColumnsFor(deps)
    const importId = Symbol('new local demo')
    await openFilesFor(deps, [new File(['same bytes'], 'run-a.csv')], { importId, localOnly: true })
    confirmPendingColumnsFor(deps, mapping)
    analysis.resolve(result())
    await vi.waitFor(() => expect(datasetsBox.current).toHaveLength(1))
    commit(deps, datasetsBox)
    expect(deps.imports.current.get(datasetsBox.current[0] as Dataset)).toMatchObject({
      importId,
      localOnly: true,
    })
    reconcileCloudFor(deps)
    expect(deps.syncToCloud).not.toHaveBeenCalled()
  })
})

describe('retained source ownership across pending work', () => {
  it.each(['opening', 'analysing'] as const)(
    'keeps a replacement source while it is %s and its obsolete demo closes',
    async (stage) => {
      const opening = deferred<OpenedSource>()
      const analysing = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      const client = successfulClient()
      const { deps, datasetsBox } = loopDeps(client)
      await openFilesFor(deps, [new File(['identical bytes'], 'old-demo.csv')], { localOnly: true })
      commit(deps, datasetsBox)
      const old = datasetsBox.current[0] as Dataset
      if (stage === 'opening') vi.mocked(client.open).mockReturnValueOnce(opening.promise)
      vi.mocked(client.analyse).mockReturnValueOnce(analysing.promise)
      const replacement = openFilesFor(deps, [new File(['identical bytes'], 'replacement.csv')], {
        localOnly: true,
      })
      await vi.waitFor(() =>
        expect(stage === 'opening' ? client.open : client.analyse).toHaveBeenCalledTimes(2),
      )
      closeDatasetFor(deps, old)
      commit(deps, datasetsBox)
      expect(client.release).not.toHaveBeenCalled()
      expect(deps.sourceFiles.current.has(SHA)).toBe(true)
      opening.resolve({ ...openedSource('replacement.csv'), suggestedMapping: mapping })
      analysing.resolve(result('replacement.csv'))
      await replacement
      commit(deps, datasetsBox)
      // Force the bounded worker cache's normal eviction path: recovery must still have a File.
      vi.mocked(client.analyse).mockRejectedValueOnce(
        new AnalysisWorkerError('SOURCE_NOT_RETAINED', 'evicted', [], []),
      )
      await runAnalysisFor(deps, {
        source: openedSourceForDataset(datasetsBox.current[0] as Dataset),
        mapping,
      })
      commit(deps, datasetsBox)
      expect(client.open).toHaveBeenCalledTimes(3)
      expect(client.release).not.toHaveBeenCalled()
      expect(deps.notify).not.toHaveBeenCalled()
      expect(datasetsBox.current[0]?.filename).toBe('replacement.csv')
      closeDatasetFor(deps, datasetsBox.current[0] as Dataset)
      expect(client.release).toHaveBeenCalledExactlyOnceWith(SHA)
    },
  )

  it.each([false, true])(
    'cleans up a stale open only if a surviving import does not own its hash (shared=%s)',
    async (shared) => {
      const oldOpen = deferred<OpenedSource>()
      const survivor = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      const client = successfulClient()
      vi.mocked(client.open).mockReturnValueOnce(oldOpen.promise)
      const { deps, datasetsBox } = loopDeps(client)
      const old = openFilesFor(deps, [new File(['old bytes'], 'run-a.csv')])
      await vi.waitFor(() => expect(client.open).toHaveBeenCalledTimes(1))
      cancelAnalysisFor(deps)
      const survivingHash = shared ? SHA : 'b'.repeat(64)
      vi.mocked(client.open).mockImplementationOnce(async (filename) => ({
        ...openedSource(filename, survivingHash),
        suggestedMapping: mapping,
      }))
      vi.mocked(client.analyse).mockReturnValueOnce(survivor.promise)
      const replacement = openFilesFor(deps, [new File(['surviving bytes'], 'run-a.csv')])
      await vi.waitFor(() => expect(client.analyse).toHaveBeenCalledTimes(1))
      oldOpen.resolve({ ...openedSource('run-a.csv'), suggestedMapping: mapping })
      await old
      if (shared) expect(client.release).not.toHaveBeenCalled()
      else expect(client.release).toHaveBeenCalledExactlyOnceWith(SHA)
      survivor.resolve(result('run-a.csv', mapping, survivingHash))
      await replacement
      expect(datasetsBox.current).toHaveLength(1)
      expect(datasetsBox.current[0]?.sourceSha256).toBe(survivingHash)
      expect(deps.sourceFiles.current.has(survivingHash)).toBe(true)
    },
  )

  it.each([false, true])(
    'defers stale-open cleanup until the surviving open reveals its hash (shared=%s)',
    async (shared) => {
      const oldOpen = deferred<OpenedSource>()
      const nextOpen = deferred<OpenedSource>()
      const client = successfulClient()
      vi.mocked(client.open).mockReturnValueOnce(oldOpen.promise).mockReturnValueOnce(nextOpen.promise)
      vi.mocked(client.analyse).mockImplementation(async (input) =>
        result(input.filename, input.mapping, input.sourceSha256),
      )
      const { deps, datasetsBox } = loopDeps(client)
      const old = openFilesFor(deps, [new File(['old'], 'old.csv')])
      await vi.waitFor(() => expect(client.open).toHaveBeenCalledTimes(1))
      cancelAnalysisFor(deps)
      const next = openFilesFor(deps, [new File(['next'], 'next.csv')])
      await vi.waitFor(() => expect(client.open).toHaveBeenCalledTimes(2))
      oldOpen.resolve(openedSource('old.csv'))
      await old
      expect(client.release).not.toHaveBeenCalled()
      const hash = shared ? SHA : 'b'.repeat(64)
      nextOpen.resolve({ ...openedSource('next.csv', hash), suggestedMapping: mapping })
      await next
      expect(datasetsBox.current).toHaveLength(1)
      if (shared) expect(client.release).not.toHaveBeenCalled()
      else expect(client.release).toHaveBeenCalledExactlyOnceWith(SHA)
    },
  )

  it.each([false, true])(
    'cleans up a stale recovery only if no surviving request owns the reopened hash (shared=%s)',
    async (shared) => {
      const reopened = deferred<OpenedSource>()
      const survivor = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      const client = successfulClient()
      vi.mocked(client.analyse).mockRejectedValueOnce(
        new AnalysisWorkerError('SOURCE_NOT_RETAINED', 'evicted', [], []),
      )
      vi.mocked(client.open).mockReturnValueOnce(reopened.promise)
      const { deps, datasetsBox } = loopDeps(client)
      deps.sourceFiles.current.set(SHA, new File(['bytes'], 'old.csv'))
      const old = runAnalysisFor(deps, { source: openedSource('old.csv'), mapping })
      await vi.waitFor(() => expect(client.open).toHaveBeenCalledTimes(1))
      cancelAnalysisFor(deps)
      const hash = shared ? SHA : 'b'.repeat(64)
      vi.mocked(client.analyse).mockReturnValueOnce(survivor.promise)
      const next = runAnalysisFor(deps, { source: openedSource('next.csv', hash), mapping })
      reopened.resolve(openedSource('old.csv'))
      await old
      if (shared) expect(client.release).not.toHaveBeenCalled()
      else expect(client.release).toHaveBeenCalledExactlyOnceWith(SHA)
      survivor.resolve(result('next.csv', mapping, hash))
      await next
      expect(datasetsBox.current).toHaveLength(1)
      expect(datasetsBox.current[0]?.filename).toBe('next.csv')
    },
  )
})
