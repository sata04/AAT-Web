// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchRevision,
  fetchRun,
  listPosters,
  listRevisions,
  type PosterFigure,
  type RevisionSummary,
  type RunSummary,
} from '../../src/cloud/gateway.ts'
import { generateAutoPoster } from '../../src/poster/requests.ts'
import { fetchSnapshotBytes } from '../../src/runs/api.ts'
import { decodeSnapshotBytes, type ReplayedAnalysis, replayFromSnapshot } from '../../src/runs/replay.ts'
import { openSnapshotFor, runAutoPosterFor, useRunDetailData } from '../../src/screens/run-detail-data.ts'

vi.mock('../../src/cloud/gateway.ts', async (original) => ({
  ...(await original<object>()),
  fetchRun: vi.fn(),
  listRevisions: vi.fn(),
  fetchRevision: vi.fn(),
  listPosters: vi.fn(),
}))
vi.mock('../../src/runs/api.ts', async (original) => ({
  ...(await original<object>()),
  fetchSnapshotBytes: vi.fn(),
}))
vi.mock('../../src/runs/replay.ts', async (original) => ({
  ...(await original<object>()),
  decodeSnapshotBytes: vi.fn(),
  replayFromSnapshot: vi.fn(),
}))
vi.mock('../../src/poster/requests.ts', async (original) => ({
  ...(await original<object>()),
  generateAutoPoster: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const run = { id: 'run', runCode: '260811', originalFilename: '260811_data.csv' } as RunSummary
const a = { id: 'a', revisionNumber: 2 } as RevisionSummary
const b = { id: 'b', revisionNumber: 1 } as RevisionSummary
const unavailable = { ok: false, kind: 'unavailable', message: 'offline' } as const
const poster = (id: string, revisionId: string) =>
  ({ posterId: id, analysisRevisionId: revisionId, kind: 'auto', status: 'ready' }) as PosterFigure

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchRun).mockResolvedValue({ ok: true, value: { run, revisions: [] } })
  vi.mocked(listRevisions).mockResolvedValue({ ok: true, value: { revisions: [a, b] } })
  vi.mocked(fetchRevision).mockResolvedValue({ ok: true, value: { revision: a, metrics: null, config: {} } })
  vi.mocked(listPosters).mockResolvedValue({ ok: true, value: { posters: [] } })
  vi.mocked(fetchSnapshotBytes).mockResolvedValue({ ok: true, value: new Uint8Array() })
  vi.mocked(decodeSnapshotBytes).mockResolvedValue({} as Awaited<ReturnType<typeof decodeSnapshotBytes>>)
  vi.mocked(replayFromSnapshot).mockReturnValue({ dataset: {} } as ReplayedAnalysis)
})
afterEach(cleanup)

async function ready() {
  const hook = renderHook(() => useRunDetailData('signed-in', 'run'))
  await waitFor(() => expect(hook.result.current.selectedRevisionId).toBe('a'))
  await waitFor(() => expect(hook.result.current.postersState.kind).toBe('ready'))
  return hook
}

describe('child resource availability', () => {
  it('distinguishes unavailable revisions from a successful empty history and retries', async () => {
    vi.mocked(listRevisions)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce({ ok: true, value: { revisions: [] } })
    const { result } = renderHook(() => useRunDetailData('signed-in', 'run'))
    await waitFor(() => expect(result.current.revisionsState.kind).toBe('error'))
    expect(result.current.run.kind).toBe('ready')
    act(() => result.current.retryRevisions())
    await waitFor(() => expect(result.current.revisionsState).toEqual({ kind: 'ready', value: [] }))
  })
  it('keeps loaded history and posters when a retry fails, and reports metrics failure separately', async () => {
    const saved = poster('saved', 'a')
    vi.mocked(listPosters)
      .mockResolvedValueOnce({ ok: true, value: { posters: [saved] } })
      .mockResolvedValue(unavailable)
    vi.mocked(fetchRevision).mockResolvedValueOnce({
      ok: true,
      value: {
        revision: a,
        config: {},
        metrics: {
          windowSize: 1,
          inner: { mean: 0.01, std: 0.001, startTime: 0 },
          drag: { mean: null, std: null, startTime: null },
          innerSampleCount: 100,
          dragSampleCount: 0,
          warningCount: 0,
          gQuality: [],
        },
      },
    })
    const { result } = await ready()
    const previousMetrics = result.current.metrics
    expect(previousMetrics?.inner.mean).toBe(0.01)
    vi.mocked(listRevisions).mockResolvedValue(unavailable)
    vi.mocked(fetchRevision).mockResolvedValue(unavailable)
    act(() => {
      result.current.retryRevisions()
      result.current.retryMetrics()
      result.current.retryPosters()
    })
    await waitFor(() => expect(result.current.postersState.kind).toBe('error'))
    expect(result.current.posters).toEqual([saved])
    expect(result.current.revisionsState.kind).toBe('error')
    expect(result.current.revisions).toEqual([a, b])
    expect(result.current.metricsState.kind).toBe('error')
    expect(result.current.metrics).toBe(previousMetrics)
    expect(result.current.selectedRevisionId).toBe('a')
    vi.mocked(fetchRevision).mockResolvedValue({
      ok: true,
      value: { revision: a, metrics: null, config: {} },
    })
    act(() => result.current.retryMetrics())
    await waitFor(() => expect(result.current.metricsState).toEqual({ kind: 'ready', value: null }))
  })
  it('drops child responses from a previous selection', async () => {
    const older = deferred<Awaited<ReturnType<typeof listPosters>>>()
    vi.mocked(listPosters)
      .mockReturnValueOnce(older.promise)
      .mockResolvedValue({ ok: true, value: { posters: [poster('b-poster', 'b')] } })
    const { result } = renderHook(() => useRunDetailData('signed-in', 'run'))
    await waitFor(() => expect(result.current.selectedRevisionId).toBe('a'))
    act(() => result.current.setSelectedRevisionId('b'))
    await waitFor(() => expect(result.current.postersState.kind).toBe('ready'))
    await act(async () => older.resolve({ ok: true, value: { posters: [poster('a-poster', 'a')] } }))
    expect(result.current.posters.map((p) => p.posterId)).toEqual(['b-poster'])
  })
})

describe('revision action races', () => {
  it('ignores a snapshot that finishes after switching away and back', async () => {
    const bytes = deferred<Awaited<ReturnType<typeof fetchSnapshotBytes>>>()
    vi.mocked(fetchSnapshotBytes).mockReturnValue(bytes.promise)
    const { result } = await ready()
    let opening!: Promise<void>
    act(() => {
      opening = openSnapshotFor(
        result.current.mounted,
        a,
        result.current.setReplay,
        result.current.revisionScope,
      )
    })
    expect(result.current.replay.kind).toBe('loading')
    act(() => result.current.setSelectedRevisionId('b'))
    expect(result.current.replay.kind).toBe('idle')
    act(() => result.current.setSelectedRevisionId('a'))
    await act(async () => {
      bytes.resolve({ ok: true, value: new Uint8Array() })
      await opening
    })
    expect(result.current.replay.kind).toBe('idle')
  })
  it('ignores a snapshot decode that finishes on a different revision', async () => {
    const decoded = deferred<Awaited<ReturnType<typeof decodeSnapshotBytes>>>()
    vi.mocked(decodeSnapshotBytes).mockReturnValue(decoded.promise)
    const { result } = await ready()
    let opening!: Promise<void>
    act(() => {
      opening = openSnapshotFor(
        result.current.mounted,
        a,
        result.current.setReplay,
        result.current.revisionScope,
      )
    })
    await waitFor(() => expect(decodeSnapshotBytes).toHaveBeenCalled())
    act(() => result.current.setSelectedRevisionId('b'))
    await act(async () => {
      decoded.resolve({} as Awaited<ReturnType<typeof decodeSnapshotBytes>>)
      await opening
    })
    expect(result.current.replay.kind).toBe('idle')
  })
  it('drops old poster progress, results and notices after changing revisions', async () => {
    const pending = deferred<Awaited<ReturnType<typeof generateAutoPoster>>>()
    let progress: Parameters<typeof generateAutoPoster>[1] | undefined
    vi.mocked(generateAutoPoster).mockImplementation((_context, update) => {
      progress = update
      return pending.promise
    })
    const { result } = await ready()
    await act(async () =>
      openSnapshotFor(result.current.mounted, a, result.current.setReplay, result.current.revisionScope),
    )
    const notify = vi.fn()
    const setBusy = vi.fn()
    const setAutoPosterStatus = vi.fn()
    // Match the screen's call shape: the replay carries its selection scope.
    const { revisionScope: _scope, ...previous } = result.current
    let generating!: Promise<void>
    act(() => {
      generating = runAutoPosterFor({ ...previous, notify, setBusy, setAutoPosterStatus }, null)
    })
    act(() => result.current.setSelectedRevisionId('b'))
    await waitFor(() => expect(result.current.postersState.kind).toBe('ready'))
    act(() => result.current.setPosters([poster('b-poster', 'b')]))
    progress?.({ kind: 'rendering', posterId: 'a-poster' })
    await act(async () => {
      pending.resolve({ ok: true, poster: poster('a-poster', 'a') })
      await generating
    })
    expect(result.current.posters.map((p) => p.posterId)).toEqual(['b-poster'])
    expect(setAutoPosterStatus).toHaveBeenCalledExactlyOnceWith({ kind: 'unavailable' })
    expect(notify).not.toHaveBeenCalled()
    await runAutoPosterFor({ ...previous, notify, setBusy, setAutoPosterStatus }, null)
    expect(generateAutoPoster).toHaveBeenCalledTimes(1)
  })
})
