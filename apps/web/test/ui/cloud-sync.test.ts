/**
 * Cloud sync is three requests, and it was two mistakes.
 *
 * The gateway used to post a snapshot to `/api/v1/analyses` with a header-based protocol. No such
 * route has ever existed; the Worker stores an analysis as `POST /runs`, then
 * `POST /runs/:runId/revisions`, then `PUT /revisions/:revisionId/snapshot` with `declaredBytes`,
 * `sha256` and `format` as **query parameters** — because quota has to be reserved before the body
 * is read, and because R2 is handed the digest so the store verifies the write itself.
 *
 * So the assertions below are about the sequence, the methods and the parameters, and about the two
 * places the sequence has to recover rather than fail: a run code the caller already owns (the
 * normal state from the second analysis of an experiment onwards), and a filename that carries no
 * run code at all (refused locally, before a single request is made).
 *
 * Throughout, the local analysis is untouched. `syncDataset` returns a result; it never throws into
 * the analyzer, and nothing it does can invalidate the numbers the researcher already has.
 */

import { DEFAULT_ANALYSIS_CONFIG, sha256Hex } from '@aat/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import type { Dataset, SensorDataset } from '../../src/app/dataset.ts'
import { syncDataset } from '../../src/cloud/sync.ts'

const RUN_ID = 'run_01J000000000000000000000'
const REVISION_ID = 'rev_01J000000000000000000000'

const EMPTY = asFullResolution(new Float64Array(0))

function sensor(): SensorDataset {
  const time = asFullResolution(Float64Array.from([0, 0.001, 0.002, 0.003]))
  const gravity = asFullResolution(Float64Array.from([0.0001, 0.0002, 0.00015, 0.0001]))
  return {
    present: true,
    time,
    gravity,
    filteredTime: time,
    filteredGravity: gravity,
    acceleration: asFullResolution(Float64Array.from([0.001, 0.002, 0.0015, 0.001])),
    startIndex: 0,
    endIndex: 3,
  }
}

function dataset(filename = '260811a_data.csv'): Dataset {
  return {
    name: filename.replace(/\.csv$/, ''),
    filename,
    sourceSha256: 'a'.repeat(64),
    encoding: 'utf-8',
    columnNames: ['t', 'a1', 'a2'],
    mapping: { timeColumn: 't', innerColumn: 'a1', dragColumn: 'a2', useInner: true, useDrag: false },
    inner: sensor(),
    drag: {
      present: false,
      time: EMPTY,
      gravity: EMPTY,
      filteredTime: EMPTY,
      filteredGravity: EMPTY,
      acceleration: EMPTY,
      startIndex: null,
      endIndex: null,
    },
    sync: {
      innerIndex: 0,
      dragIndex: null,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 0,
    },
    filterEndIndex: 3,
    statistics: {
      inner: { mean: 0.00013, startTime: 0.001, std: 0.00004 },
      drag: { mean: null, startTime: null, std: null },
    },
    gQuality: [],
    gQualityComputed: false,
    warnings: [],
    sampleCount: 4,
    analysisTimestamp: '2026-08-11T00:00:00.000Z',
    fromCache: false,
  }
}

interface Recorded {
  method: string
  path: string
  query: URLSearchParams
  body: BodyInit | null | undefined
}

const recorded: Recorded[] = []
const realFetch = globalThis.fetch

/** Answers for the happy path; a test may override one entry to exercise a refusal. */
type Responder = (request: Recorded) => Response

function happyPath(): Responder {
  return (request) => {
    if (request.method === 'POST' && request.path === '/api/v1/runs') {
      return json({ run: { id: RUN_ID, runCode: '260811a', experimentDate: '2026-08-11' } }, 201)
    }
    if (request.method === 'POST' && request.path === `/api/v1/runs/${RUN_ID}/revisions`) {
      return json({ revision: { id: REVISION_ID }, created: true }, 201)
    }
    if (request.method === 'PUT' && request.path === `/api/v1/revisions/${REVISION_ID}/snapshot`) {
      return json({ object: { id: 'obj_1', byteSize: 4096 }, created: true }, 201)
    }
    return json({ error: { code: 'RESOURCE_NOT_FOUND', message: 'not found' } }, 404)
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function install(responder: Responder): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://aat.test')
    const request: Recorded = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      body: init?.body,
    }
    recorded.push(request)
    return responder(request)
  }) as typeof fetch
}

beforeEach(() => {
  recorded.length = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('storing an analysis', () => {
  it('creates the run, then the revision, then attaches the snapshot', async () => {
    install(happyPath())
    const outcome = await syncDataset(dataset(), DEFAULT_ANALYSIS_CONFIG)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value).toMatchObject({
      runId: RUN_ID,
      runCode: '260811a',
      revisionId: REVISION_ID,
      revisionCreated: true,
    })

    expect(recorded.map((request) => `${request.method} ${request.path}`)).toEqual([
      'POST /api/v1/runs',
      `POST /api/v1/runs/${RUN_ID}/revisions`,
      `PUT /api/v1/revisions/${REVISION_ID}/snapshot`,
    ])
  })

  it('declares the snapshot as query parameters, matching the bytes it sends', async () => {
    install(happyPath())
    await syncDataset(dataset(), DEFAULT_ANALYSIS_CONFIG)

    const upload = recorded[2]
    expect(upload).toBeDefined()
    if (upload === undefined) return

    const body = upload.body as Uint8Array
    expect(body).toBeInstanceOf(Uint8Array)
    expect(upload.query.get('format')).toBe('json.gz')
    expect(upload.query.get('declaredBytes')).toBe(String(body.length))
    // The Worker re-hashes the body while reading it, and R2 verifies the digest again on write.
    // A declared hash that does not describe the bytes is refused, so it had better describe them.
    expect(upload.query.get('sha256')).toBe(await sha256Hex(body))
  })

  it('sends the revision keyed on the source bytes and the configuration', async () => {
    install(happyPath())
    await syncDataset(dataset(), DEFAULT_ANALYSIS_CONFIG)

    const revision = recorded[1]
    expect(revision).toBeDefined()
    const body = JSON.parse(String(revision?.body)) as {
      sourceSha256: string
      configHash: string
      snapshotFormatVersion: number
      metrics: { innerSampleCount: number; dragSampleCount: number }
    }
    expect(body.sourceSha256).toBe('a'.repeat(64))
    expect(body.configHash).toMatch(/^[0-9a-f]{64}$/)
    expect(body.snapshotFormatVersion).toBe(1)
    // The filtered segment is what the statistics describe, so it is the count filed with them.
    expect(body.metrics.innerSampleCount).toBe(4)
    expect(body.metrics.dragSampleCount).toBe(0)
  })
})

describe('a run that already exists', () => {
  it('attaches a new revision to it instead of failing', async () => {
    const happy = happyPath()
    install((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/runs') {
        // What the Worker actually answers for a run code this owner already has. The `runId` in
        // the details is the whole reason `CloudOutcome` carries them.
        return json(
          {
            error: {
              code: 'INVALID_ANALYSIS_CONFIG',
              message: '解析設定が無効です。',
              details: { reason: 'run_code_already_exists', runCode: '260811a', runId: RUN_ID },
            },
          },
          400,
        )
      }
      return happy(request)
    })

    const outcome = await syncDataset(dataset(), DEFAULT_ANALYSIS_CONFIG)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.value.runId).toBe(RUN_ID)
    expect(recorded).toHaveLength(3)
  })

  it('still fails for a refusal it cannot recover from', async () => {
    const happy = happyPath()
    install((request) => {
      if (request.method === 'POST' && request.path === '/api/v1/runs') {
        return json({ error: { code: 'QUOTA_EXCEEDED', message: '利用上限に達しました。' } }, 429)
      }
      return happy(request)
    })

    const outcome = await syncDataset(dataset(), DEFAULT_ANALYSIS_CONFIG)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind === 'error' && outcome.code).toBe('QUOTA_EXCEEDED')
    // Nothing was attempted after the refusal: a revision with no run is not a thing to create.
    expect(recorded).toHaveLength(1)
  })
})

describe('a filename with no run code', () => {
  it('is refused locally, without a request', async () => {
    install(happyPath())
    const outcome = await syncDataset(dataset('experiment_final_v2.csv'), DEFAULT_ANALYSIS_CONFIG)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.kind).toBe('error')
    // Retrying identical inputs would fail identically; the remedy is the filename, and the
    // message says so rather than offering a button that cannot help.
    expect(outcome.kind === 'error' && outcome.retryable).toBe(false)
    expect(outcome.message).toContain('YYMMDD_data.csv')
    expect(recorded).toHaveLength(0)
  })
})
