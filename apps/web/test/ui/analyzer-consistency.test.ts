// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisClient } from '../../src/analysis/client.ts'
import type { AnalysisPayload, OpenedSource } from '../../src/analysis/protocol.ts'
import type { OnboardingStageProps } from '../../src/onboarding/OnboardingStage.tsx'
import { AnalyzerScreen } from '../../src/screens/AnalyzerScreen.tsx'
import type { AnalyzerViewProps } from '../../src/screens/AnalyzerView.tsx'
import type { SessionStatus } from '../../src/session/SessionProvider.tsx'

const harness = vi.hoisted(() => ({
  view: undefined as AnalyzerViewProps | undefined,
  tour: undefined as OnboardingStageProps | undefined,
  status: 'loading' as SessionStatus,
  analyse: vi.fn<AnalysisClient['analyse']>(),
  open: vi.fn<AnalysisClient['open']>(),
  dispose: vi.fn(),
  sync: vi.fn(async () => {}),
}))
vi.mock('../../src/screens/AnalyzerView.tsx', () => ({
  AnalyzerView: (props: AnalyzerViewProps) => {
    harness.view = props
    return null
  },
}))
vi.mock('../../src/onboarding/OnboardingStage.tsx', () => ({
  default: (props: OnboardingStageProps) => {
    harness.tour = props
    return null
  },
}))
vi.mock('../../src/session/SessionProvider.tsx', () => ({ useSession: () => ({ status: harness.status }) }))
vi.mock('../../src/screens/analyzer-cloud.ts', async (original) => ({
  ...(await original<object>()),
  useCloudSync: () => ({
    cloudSubject: null,
    syncedPoster: null,
    syncToCloud: harness.sync,
    startAutoPoster: vi.fn(),
  }),
}))
vi.mock('../../src/analysis/client.ts', async (original) => ({
  ...(await original<object>()),
  AnalysisClient: class {
    open = harness.open
    analyse = harness.analyse
    release = vi.fn(async () => {})
    dispose = harness.dispose
    cancelPending = vi.fn()
  },
}))
// These tests exercise screen/loop ownership and lifecycle; plotting and numeric conversion are separate lanes.
vi.mock('../../src/app/dataset.ts', async (original) => ({
  ...(await original<object>()),
  datasetFromPayload: (payload: AnalysisPayload, config: unknown) => ({
    name: payload.filename.replace(/\.csv$/, ''),
    filename: payload.filename,
    sourceSha256: payload.sourceSha256,
    warnings: [],
    mapping: payload.mapping,
    config,
  }),
}))
vi.mock('../../src/graph/plot-model.ts', () => ({
  buildPlotModel: () => ({}),
  modelDataRange: () => null,
  defaultViewportFor: () => ({ min: 0, max: 1 }),
  graphBoundsFor: () => ({ min: 0, max: 1 }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const mapping = { timeColumn: 't', innerColumn: 'a', dragColumn: 'a', useInner: true, useDrag: false }
function result(filename: string) {
  return { payload: { filename, sourceSha256: filename, mapping } as AnalysisPayload, fromCache: false }
}
function view() {
  if (harness.view === undefined) throw new Error('screen not rendered')
  return harness.view
}
function tour() {
  if (harness.tour === undefined) throw new Error('tour not rendered')
  return harness.tour
}
function file(filename: string, read = Promise.resolve(new ArrayBuffer(1))) {
  const value = new File(['real'], filename)
  value.arrayBuffer = () => read
  return value
}

beforeEach(() => {
  vi.clearAllMocks()
  harness.view = undefined
  harness.tour = undefined
  harness.status = 'loading'
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    clear: () => storage.clear(),
  })
  vi.stubGlobal('File', NodeFile)
  localStorage.clear()
  localStorage.setItem(
    'aat.onboarding.v1',
    JSON.stringify({ welcomeSeen: true, graphHintSeen: false, rangeHintSeen: false, compareHintSeen: false }),
  )
  harness.open.mockImplementation(
    async (filename) => ({ filename, sourceSha256: filename, suggestedMapping: mapping }) as OpenedSource,
  )
  harness.analyse.mockImplementation(async (input) => result(input.filename))
  // jsdom's File lacks arrayBuffer; the tour still goes through the real open/read path.
  vi.spyOn(File.prototype, 'arrayBuffer').mockResolvedValue(new ArrayBuffer(1))
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('analyzer state consistency', () => {
  it.each([true, false])(
    'reconciles bootstrap sign-in with analysisFinishedFirst=%s',
    async (analysisFirst) => {
      const analysis = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      harness.analyse.mockReturnValue(analysis.promise)
      const mounted = render(createElement(StrictMode, null, createElement(AnalyzerScreen)))
      let opening!: Promise<void>
      act(() => {
        opening = view().actions.openFiles([file('260811_data.csv')])
      })
      await waitFor(() => expect(harness.analyse).toHaveBeenCalled())
      if (analysisFirst) {
        await act(async () => {
          analysis.resolve(result('260811_data.csv'))
          await opening
        })
        expect(harness.sync).not.toHaveBeenCalled()
      }
      harness.status = 'signed-in'
      mounted.rerender(createElement(StrictMode, null, createElement(AnalyzerScreen)))
      if (!analysisFirst)
        await act(async () => {
          analysis.resolve(result('260811_data.csv'))
          await opening
        })
      await waitFor(() => expect(harness.sync).toHaveBeenCalledTimes(1))
      mounted.rerender(createElement(StrictMode, null, createElement(AnalyzerScreen)))
      expect(harness.sync).toHaveBeenCalledTimes(1)
    },
  )

  it.each([false, true])(
    'reserves a real import through commit (finished=%s) and Skip removes only the demo',
    async (finished) => {
      const real = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      const demo = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
      harness.analyse.mockImplementation((input) =>
        input.filename === 'sample-a.csv' ? real.promise : demo.promise,
      )
      render(createElement(AnalyzerScreen))
      let opening!: Promise<void>
      act(() => {
        opening = view().actions.openFiles([file('sample-a.csv')])
      })
      await waitFor(() => expect(harness.analyse).toHaveBeenCalledTimes(1))
      act(() => view().actions.reopenTour())
      await waitFor(() => expect(harness.tour).toBeDefined())
      let demoOpening!: Promise<string>
      await act(async () => {
        if (finished) {
          real.resolve(result('sample-a.csv'))
          await opening
        }
        demoOpening = tour().driver.openDemo('a')
      })
      await waitFor(() => expect(harness.analyse).toHaveBeenCalledTimes(2))
      const demoName = harness.analyse.mock.calls[1]?.[0].filename as string
      expect(demoName).not.toBe('sample-a.csv')
      if (!finished)
        await act(async () => {
          real.resolve(result('sample-a.csv'))
          await opening
        })
      act(() => tour().onFinish('skip', true, false))
      await act(async () => {
        demo.resolve(result(demoName))
        await demoOpening
      })
      expect(view().state.datasets.map((dataset) => dataset.filename)).toEqual(['sample-a.csv'])
    },
  )

  it('removes obsolete demo imports when a replay restarts while analysis is pending', async () => {
    const older = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    const newer = deferred<Awaited<ReturnType<AnalysisClient['analyse']>>>()
    harness.analyse.mockImplementationOnce(() => older.promise).mockImplementationOnce(() => newer.promise)
    render(createElement(AnalyzerScreen))
    act(() => view().actions.reopenTour())
    await waitFor(() => expect(harness.tour).toBeDefined())
    let first!: Promise<string>
    let second!: Promise<string>
    act(() => {
      first = tour().driver.openDemo('a')
    })
    await waitFor(() => expect(harness.analyse).toHaveBeenCalledTimes(1))
    act(() => {
      tour().driver.closeTourDatasets()
      second = tour().driver.openDemo('a')
    })
    await waitFor(() => expect(harness.analyse).toHaveBeenCalledTimes(2))
    const firstName = harness.analyse.mock.calls[0]?.[0].filename as string
    const secondName = harness.analyse.mock.calls[1]?.[0].filename as string
    expect(firstName).not.toBe(secondName)
    await act(async () => {
      newer.resolve(result(secondName))
      await second
    })
    await act(async () => {
      older.resolve(result(firstName))
      await first
    })
    expect(view().state.datasets.map((dataset) => dataset.filename)).toEqual([secondName])
    act(() => tour().onFinish('skip', true, false))
    expect(view().state.datasets).toEqual([])
  })

  it('returns the reserved filename when replaying a displayed demo', async () => {
    render(createElement(AnalyzerScreen))
    act(() => view().actions.reopenTour())
    await waitFor(() => expect(harness.tour).toBeDefined())
    let first!: string
    let second!: string
    await act(async () => {
      first = await tour().driver.openDemo('a')
    })
    expect(view().state.datasets.some((dataset) => dataset.filename === first)).toBe(true)
    await act(async () => {
      tour().driver.closeTourDatasets()
      second = await tour().driver.openDemo('a')
    })
    expect(second).not.toBe(first)
    expect(view().state.datasets.map((dataset) => dataset.filename)).toEqual([second])
  })

  it('keeps early-takeover progressive hints unseen and tour data local after sign-in', async () => {
    const mounted = render(createElement(AnalyzerScreen))
    act(() => view().actions.reopenTour())
    await waitFor(() => expect(harness.tour).toBeDefined())
    await act(async () => {
      await tour().driver.openDemo('a')
    })
    act(() => tour().onFinish('keep', true, false))
    const flags = JSON.parse(localStorage.getItem('aat.onboarding.v1') ?? '{}')
    expect(flags).toMatchObject({ graphHintSeen: false, rangeHintSeen: false, compareHintSeen: false })
    harness.status = 'signed-in'
    mounted.rerender(createElement(AnalyzerScreen))
    expect(harness.sync).not.toHaveBeenCalled()
  })

  it('does not create worker work when a read completes after unmount', async () => {
    const read = deferred<ArrayBuffer>()
    const mounted = render(createElement(AnalyzerScreen))
    let opening!: Promise<void>
    act(() => {
      opening = view().actions.openFiles([file('260811_data.csv', read.promise), file('260812_data.csv')])
    })
    mounted.unmount()
    expect(harness.dispose).toHaveBeenCalled()
    read.resolve(new ArrayBuffer(1))
    await opening
    expect(harness.open).not.toHaveBeenCalled()
    expect(harness.analyse).not.toHaveBeenCalled()
  })
})
