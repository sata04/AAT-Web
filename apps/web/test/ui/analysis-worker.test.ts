/**
 * The retained-table lifecycle inside the analysis worker, driven through its
 * real message interface with `self` stubbed out.
 *
 * This is where the release/open ordering bugs live: a `release` that lands
 * while an `open` is still parsing must stop that open from retaining the
 * table, while a `release` for an already-evicted source must leave no trace —
 * a stale marker would be consumed by the source's *next* open and make the
 * following analyse fail with SOURCE_NOT_RETAINED.
 */

import { DEFAULT_ANALYSIS_CONFIG, sha256Hex } from '@aat/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisWorkerRequest, ColumnMapping, OpenedMessage } from '../../src/analysis/protocol.ts'

const MAPPING: ColumnMapping = {
  timeColumn: 'Time(s)',
  innerColumn: 'Z-axis acceleration 1(m/s²)',
  dragColumn: 'Z-axis acceleration 2(m/s²)',
  useInner: true,
  useDrag: true,
}

interface Posted {
  type: string
  requestId?: string
  code?: string
  stage?: string
}

let dispatch: (request: AnalysisWorkerRequest) => void
let posted: Posted[]
let sequence = 0

/** A distinct, analysable CSV per index — content differs so the hashes do. */
function csvBytes(index: number): ArrayBuffer {
  const rows = ['Time(s),Z-axis acceleration 1(m/s²),Z-axis acceleration 2(m/s²)']
  const g = 9.797578
  const count = 2000 + index
  for (let row = 0; row < count; row++) {
    const t = row / 1000
    const acceleration = t < 0.3 ? g : t < 1.5 ? 0.001 * Math.sin(row / 13) : 12 * g
    rows.push(`${t},${-acceleration},${acceleration}`)
  }
  return new TextEncoder().encode(`${rows.join('\n')}\n`).buffer as ArrayBuffer
}

/** Any request with the id left for the harness to fill in (cancel is excluded — it ids by `requestIds`). */
type RequestDraft =
  Exclude<AnalysisWorkerRequest, { type: 'cancel' }> extends infer R
    ? R extends AnalysisWorkerRequest
      ? Omit<R, 'requestId'> & { requestId?: string }
      : never
    : never

function send(request: RequestDraft): string {
  const requestId = request.requestId ?? `req-${sequence++}`
  dispatch({ ...request, requestId })
  return requestId
}

/** Macrotask loop until a matching message lands — worker awaits are real. */
async function waitFor(match: (message: Posted) => boolean, what: string): Promise<Posted> {
  for (let turn = 0; turn < 2000; turn++) {
    const found = posted.find(match)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const terminalFor = (requestId: string) => (message: Posted) =>
  message.requestId === requestId && (message.type === 'opened' || message.type === 'error')

async function openFile(index: number): Promise<string> {
  const requestId = send({ type: 'open', filename: `f${index}.csv`, bytes: csvBytes(index) })
  const message = await waitFor(terminalFor(requestId), 'opened')
  expect(message.type).toBe('opened')
  return (message as unknown as OpenedMessage).source.sourceSha256
}

async function analyse(sourceSha256: string, filename: string): Promise<Posted> {
  const requestId = send({
    type: 'analyse',
    sourceSha256,
    filename,
    config: DEFAULT_ANALYSIS_CONFIG,
    mapping: MAPPING,
    skipGQuality: true,
    useCache: false,
  })
  return waitFor(
    (message) => message.requestId === requestId && (message.type === 'analysed' || message.type === 'error'),
    'analysed',
  )
}

beforeEach(async () => {
  posted = []
  sequence = 0
  vi.resetModules()
  vi.stubGlobal('self', {
    addEventListener: (_type: string, listener: (event: { data: AnalysisWorkerRequest }) => void) => {
      dispatch = (request) => listener({ data: request })
    },
    postMessage: (message: Posted) => {
      posted.push(message)
    },
  })
  await import('../../src/analysis/analysis.worker.ts')
})

describe('retained-table lifecycle', () => {
  it('reopening a source released after eviction retains it again', async () => {
    // Four retained tables is the cap: the fifth open evicts the first.
    const first = await openFile(0)
    for (const index of [1, 2, 3, 4]) await openFile(index)

    // Releasing the evicted source must not leave a marker behind — there is
    // no open in flight for it to apply to.
    send({ type: 'release', sourceSha256: first })

    const reopened = await openFile(0)
    expect(reopened).toBe(first)
    const result = await analyse(first, 'f0.csv')
    // The marker bug surfaces here as SOURCE_NOT_RETAINED, not at open time.
    expect(result.type).toBe('analysed')
  })

  it('a release landing mid-open stops the open from retaining', async () => {
    const bytes = csvBytes(9)
    const requestId = send({ type: 'open', filename: 'mid.csv', bytes })
    // The 'parsing' progress post means the open has its content hash and is
    // about to suspend at its checkpoint — the window a release must catch.
    await waitFor(
      (message) =>
        message.requestId === requestId && message.type === 'progress' && message.stage === 'parsing',
      'parsing progress',
    )
    send({ type: 'release', sourceSha256: await sha256Hex(new Uint8Array(bytes)) })

    const opened = await waitFor(terminalFor(requestId), 'opened after mid-open release')
    expect(opened.type).toBe('opened')

    const result = await analyse(await sha256Hex(new Uint8Array(csvBytes(9))), 'mid.csv')
    // The dataset was closed before its table was ever usable, so analysis
    // must report the table as gone rather than resurrecting it.
    expect(result.type).toBe('error')
    expect(result.code).toBe('SOURCE_NOT_RETAINED')
  })
})
