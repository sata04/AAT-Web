/**
 * When a render may be started, and — mostly — when it may not.
 *
 * The automatic poster is one render per analysis revision. That guarantee is the database's: a
 * partial unique index on `(analysis_revision_id, preset_version) WHERE kind = 'auto'`, claimed by
 * an `INSERT ... ON CONFLICT DO NOTHING`, so a repeat call reads the existing row back and renders
 * nothing. The browser is not asked to be clever about it, and deliberately keeps no second flag of
 * its own — a client-side check loses to a reload, a second tab and another device, and having two
 * mechanisms would make it unclear which one was holding the line.
 *
 * What the browser *is* responsible for is the shape of its requests, which is what this file
 * asserts:
 *
 *  - one POST per generate, and never a second one behind a poll;
 *  - a figure that is still rendering is followed with the *listing* endpoint, which renders
 *    nothing — so watching a poster costs a container nothing, and neither does a rerender;
 *  - a failed figure is retried through `POST /posters/:id/retry`, which is conditional on it still
 *    being failed, rather than by asking for the automatic poster again;
 *  - a spec that cannot be built sends nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import type { PosterStatus } from '../../src/cloud/status.ts'
import {
  generateAutoPoster,
  generateCustomPoster,
  type PosterContext,
  retryAutoPoster,
} from '../../src/poster/requests.ts'

const REVISION_ID = 'rev_01J000000000000000000000'
const POSTER_ID = 'pos_01J000000000000000000000'

const EMPTY = asFullResolution(new Float64Array(0))

function series(count: number) {
  const time = new Float64Array(count)
  const gravity = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    time[index] = index / 1000
    gravity[index] = 0.0001 + Math.sin(index / 9) * 0.00002
  }
  return { time: asFullResolution(time), gravity: asFullResolution(gravity) }
}

function sensor(count: number): SensorDataset {
  const { time, gravity } = series(count)
  return {
    present: count > 0,
    time,
    gravity,
    filteredTime: time,
    filteredGravity: gravity,
    acceleration: EMPTY,
    startIndex: count > 0 ? 0 : null,
    endIndex: count > 0 ? count - 1 : null,
  }
}

const ABSENT: SensorDataset = {
  present: false,
  time: EMPTY,
  gravity: EMPTY,
  filteredTime: EMPTY,
  filteredGravity: EMPTY,
  acceleration: EMPTY,
  startIndex: null,
  endIndex: null,
}

function context(innerSamples = 1000): PosterContext {
  const dataset: Dataset = {
    name: '260811a_data',
    filename: '260811a_data.csv',
    sourceSha256: 'a'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'a1', 'a2'],
    mapping: { timeColumn: 't', innerColumn: 'a1', dragColumn: 'a2', useInner: true, useDrag: false },
    inner: innerSamples > 0 ? sensor(innerSamples) : ABSENT,
    drag: ABSENT,
    sync: {
      innerIndex: 0,
      dragIndex: null,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 0,
    },
    filterEndIndex: innerSamples - 1,
    statistics: {
      inner: { mean: null, startTime: null, std: null },
      drag: { mean: null, startTime: null, std: null },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: innerSamples,
    analysisTimestamp: '2026-08-11T00:00:00.000Z',
    fromCache: false,
  }
  return { revisionId: REVISION_ID, runCode: '260811a', dataset }
}

function figure(status: 'queued' | 'rendering' | 'ready' | 'failed', failureCode: string | null = null) {
  return {
    posterId: POSTER_ID,
    analysisRevisionId: REVISION_ID,
    kind: 'auto' as const,
    presetVersion: 'aat-poster-v1',
    specHash: 'd'.repeat(64),
    status,
    rendererVersion: 'aat-poster-renderer/1.0.0',
    failureCode,
    attemptCount: 1,
    createdAt: '2026-08-11T00:00:00.000Z',
  }
}

interface Recorded {
  method: string
  path: string
}

const recorded: Recorded[] = []
const realFetch = globalThis.fetch

function install(responder: (request: Recorded) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://aat.test')
    const request: Recorded = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname }
    recorded.push(request)
    return responder(request)
  }) as typeof fetch
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function trace(): string[] {
  return recorded.map((request) => `${request.method} ${request.path}`)
}

beforeEach(() => {
  recorded.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

describe('the automatic poster', () => {
  it('makes exactly one request when the Worker answers with a finished figure', async () => {
    install(() => json({ poster: figure('ready') }, 201))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(true)
    expect(trace()).toEqual([`POST /api/v1/revisions/${REVISION_ID}/poster/auto`])
    expect(statuses.at(-1)).toEqual({
      kind: 'ready',
      url: `/api/v1/posters/${POSTER_ID}/image`,
      posterId: POSTER_ID,
    })
  })

  it('follows an in-flight render with the listing, never with another render request', async () => {
    vi.useFakeTimers()
    let listings = 0
    install((request) => {
      if (request.method === 'POST') return json({ poster: figure('rendering') }, 200)
      listings += 1
      return json({ posters: [figure(listings >= 2 ? 'ready' : 'rendering')] })
    })

    const pending = generateAutoPoster(context(), () => {})
    // Two poll ticks, which is enough for the stub to settle.
    await vi.advanceTimersByTimeAsync(6_000)
    const outcome = await pending

    expect(outcome.ok).toBe(true)
    const posts = trace().filter((entry) => entry.startsWith('POST'))
    const gets = trace().filter((entry) => entry.startsWith('GET'))
    // One render request, however many times its state was read.
    expect(posts).toEqual([`POST /api/v1/revisions/${REVISION_ID}/poster/auto`])
    expect(gets.length).toBeGreaterThanOrEqual(1)
    expect(new Set(gets)).toEqual(new Set([`GET /api/v1/revisions/${REVISION_ID}/posters`]))
  })

  it('reports a failed figure as retryable without retrying it itself', async () => {
    install(() => json({ poster: figure('failed', 'POSTER_RENDER_FAILED') }, 200))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('cloud')
    expect(outcome.kind === 'cloud' && outcome.retryable).toBe(true)
    // Exactly one request: a client that re-posted on failure would turn a persistent renderer
    // fault into a render loop, which is why the automatic endpoint refuses to retry.
    expect(trace()).toHaveLength(1)
    const last = statuses.at(-1)
    expect(last?.kind).toBe('failed')
    expect(last?.kind === 'failed' && last.posterId).toBe(POSTER_ID)
    expect(last?.kind === 'failed' && last.message).toContain('POSTER_RENDER_FAILED')
  })

  it('treats backpressure as retryable and stores nothing about it', async () => {
    install(() => json({ error: { code: 'POSTER_BUSY', message: 'ポスター生成が混み合っています。' } }, 429))
    const outcome = await generateAutoPoster(context(), () => {})

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind === 'cloud' && outcome.retryable).toBe(true)
    expect(trace()).toHaveLength(1)
  })

  it('stops writing to the lane once its request has been abandoned', async () => {
    vi.useFakeTimers()
    install((request) =>
      request.method === 'POST'
        ? json({ poster: figure('rendering') }, 200)
        : json({ posters: [figure('rendering')] }),
    )
    const controller = new AbortController()
    const statuses: PosterStatus[] = []

    const pending = generateAutoPoster(context(), (status) => statuses.push(status), controller.signal)
    await vi.advanceTimersByTimeAsync(3_000)
    const beforeAbort = statuses.length
    expect(beforeAbort).toBeGreaterThan(0)

    // What happens when a second dataset is analysed while the first one's poster is still
    // rendering: the newer request aborts this one and reports its own state immediately. A late
    // update from here would describe a figure nobody is waiting for any more.
    controller.abort()
    await vi.advanceTimersByTimeAsync(30_000)
    await pending

    expect(statuses).toHaveLength(beforeAbort)
  })

  it('sends nothing when the spec cannot be built', async () => {
    install(() => json({ poster: figure('ready') }, 201))
    // No sensor has a sample in the preset's 0 .. 1.45 s window, so there is no honest figure to
    // ask for — and asking anyway would spend a container render to be told so.
    const outcome = await generateAutoPoster(context(0), () => {})

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('spec')
    expect(recorded).toHaveLength(0)
  })
})

describe('retrying', () => {
  it('uses the retry endpoint when the failed figure has an id', async () => {
    install(() => json({ poster: figure('ready') }, 201))
    const outcome = await retryAutoPoster(context(), POSTER_ID, () => {})

    expect(outcome.ok).toBe(true)
    expect(trace()).toEqual([`POST /api/v1/posters/${POSTER_ID}/retry`])
  })

  it('falls back to the idempotent endpoint when no figure was ever created', async () => {
    install(() => json({ poster: figure('ready') }, 201))
    const outcome = await retryAutoPoster(context(), null, () => {})

    expect(outcome.ok).toBe(true)
    expect(trace()).toEqual([`POST /api/v1/revisions/${REVISION_ID}/poster/auto`])
  })
})

describe('a custom poster', () => {
  it('goes to the collection endpoint, which keeps history rather than overwriting', async () => {
    install(() => json({ poster: { ...figure('ready'), kind: 'custom' } }, 201))
    const outcome = await generateCustomPoster(context(), { series: 'inner', xMin: 0, xMax: 0.5 })

    expect(outcome.ok).toBe(true)
    expect(trace()).toEqual([`POST /api/v1/revisions/${REVISION_ID}/posters`])
  })

  it('refuses a range with no samples before sending anything', async () => {
    install(() => json({ poster: figure('ready') }, 201))
    const outcome = await generateCustomPoster(context(), { series: 'inner', xMin: 50, xMax: 60 })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('spec')
    expect(outcome.kind === 'spec' && outcome.advice.code).toBe('POSTER_RANGE_EMPTY')
    // The advice carries the range the data does cover, so the dialog can offer to move there.
    expect(outcome.kind === 'spec' && outcome.advice.action?.kind).toBe('move-to-data')
    expect(recorded).toHaveLength(0)
  })
})
