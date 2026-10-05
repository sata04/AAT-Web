/**
 * When a poster render may be started, and when it may upload.
 *
 * The figure is drawn by the local engine — `src/poster/engine/renderer.ts` — which
 * this file replaces with a stub, so the only real work under test is the wiring:
 * which status the lane sees, which request goes to the Worker and carrying what,
 * and — the contract's sharp edge — *when no request may be made at all*.
 *
 *  - every render is local: a figure that never touches the network still exists
 *    and is still downloadable;
 *  - the automatic poster uploads exactly once — the unique index keeps a repeat
 *    from storing twice — and a finished render is uploaded as
 *    `{ spec, pngBase64 }`, never as a render request;
 *  - a custom poster uploads through the collection endpoint, which keeps history
 *    rather than overwriting;
 *  - with the cloud disabled — or no revision to file under — no fetch happens;
 *  - a spec that cannot be built renders nothing and sends nothing at all.
 */

import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import type { PosterStatus } from '../../src/cloud/status.ts'
import type { PosterEngineStatus } from '../../src/poster/engine/renderer.ts'
import { generateAutoPoster, generateCustomPoster, type PosterContext } from '../../src/poster/requests.ts'

const REVISION_ID = 'rev_01J000000000000000000000'
const POSTER_ID = 'pos_01J000000000000000000000'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const EMPTY = asFullResolution(new Float64Array(0))

/* The engine, stubbed: statuses can be scripted, the PNG is fixed. */
const engine = vi.hoisted(() => ({
  render: vi.fn(async (): Promise<Uint8Array> => PNG),
  listeners: new Set<(status: PosterEngineStatus) => void>(),
  emit(status: PosterEngineStatus) {
    for (const listener of this.listeners) listener(status)
  },
}))

vi.mock('../../src/poster/engine/renderer.ts', () => ({
  renderPosterPng: () => engine.render(),
  posterEngineVersion: () => 'aat-poster-engine/test',
  onPosterEngineStatus: (callback: (status: PosterEngineStatus) => void) => {
    engine.listeners.add(callback)
    return () => engine.listeners.delete(callback)
  },
}))

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

function context(innerSamples = 1000, revisionId: string | null = REVISION_ID): PosterContext {
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
    config: DEFAULT_ANALYSIS_CONFIG,
  }
  return { revisionId, runCode: '260811a', dataset }
}

function figure(kind: 'auto' | 'custom' = 'auto') {
  return {
    posterId: POSTER_ID,
    analysisRevisionId: REVISION_ID,
    kind,
    presetVersion: 'aat-poster-v1',
    specHash: 'd'.repeat(64),
    status: 'ready',
    rendererVersion: 'aat-poster-engine/test',
    failureCode: null,
    attemptCount: 1,
    createdAt: '2026-08-11T00:00:00.000Z',
  }
}

interface Recorded {
  method: string
  path: string
  body: { spec?: { analysisRevisionId?: string; posterKind?: string }; pngBase64?: string } | null
}

const recorded: Recorded[] = []
const realFetch = globalThis.fetch

function install(responder: (request: Recorded) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://aat.test')
    const request: Recorded = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Recorded['body']) : null,
    }
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
  engine.render.mockClear()
  engine.render.mockResolvedValue(PNG)
  engine.emit({ kind: 'ready' })
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllEnvs()
})

describe('the automatic poster', () => {
  it('renders locally and uploads the finished PNG exactly once', async () => {
    install(() => json({ poster: figure('auto'), created: true }, 201))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.uploaded).toBe(true)
    expect(outcome.entry.posterId).toBe(POSTER_ID)
    expect(outcome.entry.png).toEqual(PNG)
    // One request, carrying the spec and the bytes — never a render request.
    expect(trace()).toEqual([`POST /api/v1/revisions/${REVISION_ID}/poster/auto`])
    const body = recorded[0]?.body
    expect(body?.spec?.analysisRevisionId).toBe(REVISION_ID)
    expect(body?.spec?.posterKind).toBe('auto')
    expect(body?.pngBase64).toBe(btoa(String.fromCharCode(...PNG)))
    expect(statuses.at(-1)).toEqual({
      kind: 'ready',
      url: `/api/v1/posters/${POSTER_ID}/image`,
      posterId: POSTER_ID,
    })
  })

  it('mirrors the engine lifecycle in the lane while the draw runs', async () => {
    engine.render.mockImplementation(async () => {
      engine.emit({ kind: 'loading', detail: 'first run' })
      engine.emit({ kind: 'rendering' })
      return PNG
    })
    install(() => json({ poster: figure('auto') }, 201))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(true)
    expect(statuses.map((status) => status.kind)).toEqual(['loading', 'rendering', 'uploading', 'ready'])
  })

  it('makes no request at all when there is no revision to file under', async () => {
    install(() => json({ poster: figure('auto') }, 201))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(1000, null), (status) => statuses.push(status))

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.uploaded).toBe(false)
    // The figure still exists — local render, local URL, nothing stored.
    expect(outcome.entry.posterId).toBeNull()
    expect(outcome.entry.png).toEqual(PNG)
    expect(outcome.entry.imageUrl.length).toBeGreaterThan(0)
    expect(recorded).toHaveLength(0)
    expect(statuses.at(-1)?.kind).toBe('ready')
  })

  it('makes no request at all when the cloud half is disabled at build time', async () => {
    vi.stubEnv('VITE_AAT_CLOUD_ENABLED', 'false')
    install(() => json({ poster: figure('auto') }, 201))

    const outcome = await generateAutoPoster(context(), () => {})

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.uploaded).toBe(false)
    expect(recorded).toHaveLength(0)
  })

  it('keeps the rendered entry when the upload is refused', async () => {
    install(() => json({ error: { code: 'RATE_LIMITED', message: '制限に達しました。' } }, 429))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('cloud')
    expect(outcome.kind === 'cloud' && outcome.retryable).toBe(true)
    // The image was drawn — only its cloud copy is missing.
    expect(outcome.kind === 'cloud' && outcome.entry?.png).toEqual(PNG)
    const last = statuses.at(-1)
    expect(last?.kind).toBe('failed')
    expect(last?.kind === 'failed' && last.retryable).toBe(true)
  })

  it('reports a render failure without inventing an entry', async () => {
    engine.render.mockRejectedValue(new Error('engine exploded'))
    install(() => json({ poster: figure('auto') }, 201))
    const statuses: PosterStatus[] = []

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status))

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind === 'cloud' && outcome.entry).toBeNull()
    expect(outcome.kind === 'cloud' && outcome.message).toContain('engine exploded')
    expect(recorded).toHaveLength(0)
    expect(statuses.at(-1)?.kind).toBe('failed')
  })

  it('stops writing to the lane once its request has been abandoned', async () => {
    const statuses: PosterStatus[] = []
    const controller = new AbortController()
    engine.render.mockImplementation(async () => {
      engine.emit({ kind: 'rendering' })
      controller.abort()
      return PNG
    })
    install(() => json({ poster: figure('auto') }, 201))

    const outcome = await generateAutoPoster(context(), (status) => statuses.push(status), controller.signal)

    expect(outcome.ok).toBe(true)
    // `rendering` was seen before the abort; the `uploading`/`ready` writes that
    // followed it belong to a request nobody is waiting for any more.
    expect(statuses.map((status) => status.kind)).toEqual(['rendering'])
  })

  it('renders nothing and sends nothing when the spec cannot be built', async () => {
    install(() => json({ poster: figure('auto') }, 201))
    // No sensor has a sample in the preset's 0 .. 1.45 s window, so there is no honest figure to
    // draw — and drawing anyway would spend an engine run to be told so.
    const outcome = await generateAutoPoster(context(0), () => {})

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('spec')
    expect(engine.render).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(0)
  })
})

describe('a custom poster', () => {
  it('uploads through the collection endpoint, which keeps history rather than overwriting', async () => {
    install(() => json({ poster: figure('custom') }, 201))
    const outcome = await generateCustomPoster(context(), { series: 'inner', xMin: 0, xMax: 0.5 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.entry.kind).toBe('custom')
    expect(trace()).toEqual([`POST /api/v1/revisions/${REVISION_ID}/posters`])
    expect(recorded[0]?.body?.spec?.posterKind).toBe('custom')
  })

  it('stays local-only when the context has no revision', async () => {
    install(() => json({ poster: figure('custom') }, 201))

    const outcome = await generateCustomPoster(context(1000, null), { series: 'inner', xMin: 0, xMax: 0.5 })

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.uploaded).toBe(false)
    expect(outcome.entry.posterId).toBeNull()
    expect(outcome.entry.analysisRevisionId).toBe('local')
    expect(recorded).toHaveLength(0)
  })

  it('refuses a range with no samples before rendering or sending anything', async () => {
    install(() => json({ poster: figure('custom') }, 201))
    const outcome = await generateCustomPoster(context(), { series: 'inner', xMin: 50, xMax: 60 })

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('spec')
    expect(outcome.kind === 'spec' && outcome.advice.code).toBe('POSTER_RANGE_EMPTY')
    // The advice carries the range the data does cover, so the dialog can offer to move there.
    expect(outcome.kind === 'spec' && outcome.advice.action?.kind).toBe('move-to-data')
    expect(engine.render).not.toHaveBeenCalled()
    expect(recorded).toHaveLength(0)
  })
})
