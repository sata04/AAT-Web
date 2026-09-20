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
import type { OpenedSource } from '../../src/analysis/protocol.ts'
import type { Dataset } from '../../src/app/dataset.ts'
import { type CloudStatuses, INITIAL_STATUSES } from '../../src/cloud/status.ts'
import { retrySyncFor } from '../../src/screens/analyzer-cloud.ts'
import { type AnalyzerLoopDeps, closeDatasetFor, openFilesFor } from '../../src/screens/analyzer-loop.ts'

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
