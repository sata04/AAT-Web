/**
 * The analysis Web Worker.
 *
 * Owns the whole numerical chain — decode, parse, column detection, sync and
 * gravity conversion, filtering, the minimum-standard-deviation statistics and
 * the G-quality sweep — so that a 40 MB file cannot freeze the interface
 * mid-drag. Nothing here touches the DOM, and nothing on the main thread does
 * arithmetic on a sample.
 *
 * Three implementation points that are easy to get wrong and expensive to
 * discover later:
 *
 *   - Papa Parse's `worker: true` is not used. This code is already inside a
 *     dedicated worker; nesting another is unsupported and would move the file
 *     across a second structured-clone boundary for nothing. `parseCsvText` in
 *     `@aat/analysis-core` sets `worker: false` explicitly for the same reason.
 *
 *   - Results are *transferred*, not copied. Every buffer in the payload is
 *     listed in the transfer list — except zero-length ones, because the engine
 *     returns a single shared empty array for a disabled sensor and detaching it
 *     would poison every later analysis in this worker.
 *
 *   - The parsed table is retained between `open` and `analyse` so choosing
 *     columns in the dialog does not cost a second parse. The retention is
 *     bounded; a table is raw cell text and a large file's is not small.
 */

/// <reference lib="webworker" />

import {
  AnalysisCancelledError,
  AnalysisError,
  ColumnNotFoundError,
  type CsvTable,
  calculateGQuality,
  calculateStatistics,
  decodeCsv,
  detectColumns,
  EMPTY_WINDOW_STATISTICS,
  filterData,
  loadAndProcessData,
  parseCsvText,
} from '@aat/analysis-core'
import type { AnalysisConfig } from '@aat/shared'
import { configHash, sha256Hex } from '@aat/shared'
import { ANALYSIS_ENGINE_VERSION } from '../app/version.ts'
import { cacheBudgetBytes, evictToBudget, readCache, writeCache } from '../cache/analysis-cache.ts'
import { toEngineConfig } from './engine-config.ts'
import { proposeMapping } from './mapping.ts'
import type {
  AnalysedMessage,
  AnalyseRequest,
  AnalysisPayload,
  AnalysisStage,
  AnalysisWorkerRequest,
  ColumnMapping,
  ErrorMessage,
  OpenedMessage,
  OpenRequest,
  ReleaseRequest,
  SensorResult,
} from './protocol.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope

/**
 * How many parsed tables to keep.
 *
 * Enough for a comparison of a few datasets without holding the raw text of
 * every file a long session has touched. Eviction is oldest-first.
 */
const RETAINED_TABLE_LIMIT = 4

interface RetainedTable {
  table: CsvTable
  filename: string
  encoding: 'utf-8' | 'shift_jis'
}

const retained = new Map<string, RetainedTable>()

/**
 * Sources whose `release` arrived before their `open` finished — or for a table
 * already evicted. The open still answers its request, but it must not go on to
 * retain a table the page has already closed.
 */
const releasedBeforeOpen = new Set<string>()

/**
 * Cancellation bookkeeping. `inFlight` bounds `cancelled` to requests that are
 * actually running so a stale cancel for a finished id is a no-op, and each
 * finished run clears its own flag, keeping the set from growing for the
 * lifetime of the worker.
 */
const inFlight = new Set<string>()
const cancelled = new Set<string>()

function throwIfCancelled(requestId: string): void {
  if (cancelled.has(requestId)) throw new AnalysisCancelledError()
}

/**
 * Let a queued `cancel` message run. A worker processes one message at a time,
 * so a cancellation sent while a synchronous stage is executing can only be
 * *seen* after a real event-loop turn — awaiting a resolved promise is a
 * microtask and would check the set before the cancel message ever ran.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function checkpoint(requestId: string): Promise<void> {
  await yieldToEventLoop()
  throwIfCancelled(requestId)
}

function retain(sourceSha256: string, entry: RetainedTable): void {
  // Re-inserting moves the key to the end of the Map's insertion order, which is
  // what makes the first key the least recently used.
  retained.delete(sourceSha256)
  retained.set(sourceSha256, entry)
  while (retained.size > RETAINED_TABLE_LIMIT) {
    const oldest = retained.keys().next()
    if (oldest.done === true) break
    retained.delete(oldest.value)
  }
}

function progress(requestId: string, stage: AnalysisStage, percent: number): void {
  scope.postMessage({ type: 'progress', requestId, stage, percent })
}

/**
 * Collect transferable buffers, skipping empties and duplicates.
 *
 * `postMessage` throws if the same `ArrayBuffer` appears twice in the transfer
 * list, and detaching the engine's shared zero-length buffer would break the
 * next analysis in this worker — hence both guards rather than a bare `map`.
 */
function collectTransfers(arrays: readonly Float64Array[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>()
  for (const array of arrays) {
    if (array.byteLength === 0) continue
    const buffer = array.buffer
    if (buffer instanceof ArrayBuffer) seen.add(buffer)
  }
  return [...seen]
}

function payloadTransfers(payload: AnalysisPayload): ArrayBuffer[] {
  return collectTransfers([
    payload.inner.time,
    payload.inner.gravity,
    payload.inner.filteredTime,
    payload.inner.filteredGravity,
    payload.inner.acceleration,
    payload.drag.time,
    payload.drag.gravity,
    payload.drag.filteredTime,
    payload.drag.filteredGravity,
    payload.drag.acceleration,
  ])
}

function approximateBytes(payload: AnalysisPayload): number {
  let total = 0
  for (const sensor of [payload.inner, payload.drag]) {
    total += sensor.time.byteLength
    total += sensor.gravity.byteLength
    total += sensor.filteredTime.byteLength
    total += sensor.filteredGravity.byteLength
    total += sensor.acceleration.byteLength
  }
  return total
}

function reportError(requestId: string, error: unknown): void {
  const message: ErrorMessage = { type: 'error', requestId, code: 'INTERNAL', message: String(error) }

  if (error instanceof ColumnNotFoundError) {
    message.code = error.code
    message.message = error.message
    message.missingColumns = [...error.missingColumns]
    message.availableColumns = [...error.availableColumns]
  } else if (error instanceof AnalysisError) {
    message.code = error.code
    message.message = error.message
  } else if (error instanceof Error) {
    // A non-AnalysisError (RangeError, engine bug): the name is the most
    // specific thing it carries, so it becomes the code rather than INTERNAL.
    message.code = error.name
    message.message = error.message
  }

  scope.postMessage(message)
}

async function handleOpen(request: OpenRequest): Promise<void> {
  const bytes = new Uint8Array(request.bytes)
  progress(request.requestId, 'decoding', 5)
  // Content-addressed, via Web Crypto: a renamed file is the same data and a
  // touched file is not different data. The same digest identifies the retained
  // table, the cache entry and the cloud snapshot's provenance.
  const sourceSha256 = await sha256Hex(bytes)

  const { text, encoding } = decodeCsv(bytes)
  progress(request.requestId, 'parsing', 20)

  const table = parseCsvText(text)
  // Decoding and parsing are the long synchronous stretch of `open`; the
  // earliest a cancel can land is here, at the first suspension.
  await checkpoint(request.requestId)
  progress(request.requestId, 'detecting', 45)

  const detected = detectColumns(table)
  // A `release` processed during the checkpoint above means the dataset was
  // closed mid-open: answer it (the columns were asked for) without retaining.
  if (!releasedBeforeOpen.delete(sourceSha256)) {
    retain(sourceSha256, { table, filename: request.filename, encoding })
  }

  const proposal = proposeMapping(detected)
  const message: OpenedMessage = {
    type: 'opened',
    requestId: request.requestId,
    source: {
      sourceSha256,
      filename: request.filename,
      encoding,
      columnNames: [...table.columnNames],
      detected,
      rowCount: table.rowCount,
      suggestedMapping: proposal.mapping,
      ambiguity: proposal.ambiguity,
    },
  }
  scope.postMessage(message)
}

/**
 * The cache identity for one analysis.
 *
 * `configHash` from `@aat/shared` covers only the settings that can change a
 * number, which is right — but it deliberately excludes the column mapping,
 * because a mapping describes a particular CSV rather than a configuration.
 * Reading the wrong column changes every number, so the mapping is folded in
 * here. Without this, analysing the same file twice with different columns
 * selected would hit the first result.
 */
async function analysisIdentityHash(config: AnalysisConfig, mapping: ColumnMapping): Promise<string> {
  const base = await configHash(config)
  const mappingKey = JSON.stringify([
    mapping.timeColumn,
    mapping.innerColumn,
    mapping.dragColumn,
    mapping.useInner,
    mapping.useDrag,
  ])
  return sha256Hex(`${base}|${mappingKey}`)
}

/**
 * A disabled sensor's slot in the payload.
 *
 * Freshly allocated rather than a shared constant. Zero-length buffers are
 * already excluded from the transfer list, but a module-level constant that
 * ever did get transferred would be detached for the remaining lifetime of the
 * worker — a failure mode worth designing out rather than relying on a filter.
 */
function emptySensor(): SensorResult {
  return {
    present: false,
    time: new Float64Array(0),
    gravity: new Float64Array(0),
    filteredTime: new Float64Array(0),
    filteredGravity: new Float64Array(0),
    acceleration: new Float64Array(0),
    startIndex: null,
    endIndex: null,
  }
}

async function handleAnalyse(request: AnalyseRequest): Promise<void> {
  const entry = retained.get(request.sourceSha256)
  if (entry === undefined) {
    scope.postMessage({
      type: 'error',
      requestId: request.requestId,
      code: 'SOURCE_NOT_RETAINED',
      message: 'The parsed source is no longer held by the worker; reopen the file.',
    } satisfies ErrorMessage)
    return
  }
  // Map insertion order is the LRU order; reinsert so a table in active use is
  // not evicted under a burst of opens for other datasets.
  retain(request.sourceSha256, entry)

  const identity = await analysisIdentityHash(request.config, request.mapping)
  const cacheParts = {
    sourceSha256: request.sourceSha256,
    configHash: identity,
    engineVersion: ANALYSIS_ENGINE_VERSION,
  }

  if (request.useCache) {
    const cached = await readCache<AnalysisPayload>(cacheParts)
    // A cached entry computed without the sweep must not satisfy a request that
    // needs it; the reverse is fine, extra rows are simply ignored.
    if (cached !== null && (request.skipGQuality || cached.payload.gQualityComputed)) {
      const message: AnalysedMessage = {
        type: 'analysed',
        requestId: request.requestId,
        payload: cached.payload,
        fromCache: true,
      }
      scope.postMessage(message, payloadTransfers(cached.payload))
      return
    }
  }

  const { table } = entry
  const engineConfig = toEngineConfig(request.config, request.mapping)

  await checkpoint(request.requestId)
  progress(request.requestId, 'loading', 50)
  const loaded = loadAndProcessData(table, engineConfig)

  progress(request.requestId, 'filtering', 58)
  const filtered = filterData(loaded, engineConfig)

  progress(request.requestId, 'statistics', 64)
  const statisticsConfig = { windowSize: engineConfig.windowSize, samplingRate: engineConfig.samplingRate }
  const statistics = {
    inner:
      filtered.inner.gravity.length > 0
        ? calculateStatistics(filtered.inner.gravity, filtered.inner.time, statisticsConfig)
        : EMPTY_WINDOW_STATISTICS,
    drag:
      filtered.drag.gravity.length > 0
        ? calculateStatistics(filtered.drag.gravity, filtered.drag.time, statisticsConfig)
        : EMPTY_WINDOW_STATISTICS,
  }

  const inner: SensorResult = request.mapping.useInner
    ? {
        present: filtered.inner.gravity.length > 0,
        time: loaded.inner.time,
        gravity: loaded.inner.gravity,
        filteredTime: filtered.inner.time,
        filteredGravity: filtered.inner.gravity,
        acceleration: loaded.inner.acceleration,
        startIndex: filtered.inner.startIndex,
        endIndex: filtered.inner.endIndex,
      }
    : emptySensor()

  const drag: SensorResult = request.mapping.useDrag
    ? {
        present: filtered.drag.gravity.length > 0,
        time: loaded.drag.time,
        gravity: loaded.drag.gravity,
        filteredTime: filtered.drag.time,
        filteredGravity: filtered.drag.gravity,
        acceleration: loaded.drag.acceleration,
        startIndex: filtered.drag.startIndex,
        endIndex: filtered.drag.endIndex,
      }
    : emptySensor()

  // The last chance to see a cancel before the sweep starts — the run of
  // synchronous stages above is the longest un-interruptible stretch of the
  // pipeline, and the sweep itself can take minutes on a large file.
  await checkpoint(request.requestId)

  // Checking the flag costs nothing per window; yielding to the event loop
  // costs a millisecond-scale turn, so only pay it when this sweep is taking
  // long enough that a user could plausibly reach for the cancel button.
  let lastYield = 0
  const sweepCheckpoint = async (): Promise<void> => {
    const now = Date.now()
    if (now - lastYield >= 50) {
      lastYield = now
      await yieldToEventLoop()
    }
    throwIfCancelled(request.requestId)
  }

  const gQuality = request.skipGQuality
    ? { rows: [], warnings: [] }
    : await calculateGQuality(filtered, engineConfig, {
        onProgress: (update) => {
          // The sweep dominates the wall clock, so it owns the tail of the bar.
          progress(request.requestId, 'gquality', 65 + Math.round(update.percent * 0.3))
        },
        checkpoint: sweepCheckpoint,
      })

  const payload: AnalysisPayload = {
    sourceSha256: request.sourceSha256,
    filename: request.filename,
    encoding: entry.encoding,
    columnNames: [...table.columnNames],
    detected: detectColumns(table),
    mapping: request.mapping,
    inner,
    drag,
    sync: loaded.sync,
    filterEndIndex: filtered.endIndex,
    statistics,
    gQuality: gQuality.rows,
    gQualityComputed: !request.skipGQuality,
    warnings: [...loaded.warnings, ...filtered.warnings, ...gQuality.warnings],
    sampleCount: loaded.sampleCount,
    analysisTimestamp: new Date().toISOString(),
  }

  if (request.useCache) {
    progress(request.requestId, 'caching', 97)
    const payloadBytes = approximateBytes(payload)
    const budget = await cacheBudgetBytes()
    // Written before the transfer: after `postMessage` the buffers are detached
    // and there is nothing left here to store.
    const stored = await writeCache(cacheParts, request.filename, payload, payloadBytes)
    if (!stored) {
      // The write failed under pressure, so the store is over budget even before
      // this payload: evict to a budget that excludes it, then try once more.
      await evictToBudget(Math.max(0, budget - payloadBytes))
      await writeCache(cacheParts, request.filename, payload, payloadBytes)
    } else {
      // The write succeeded but the store is still over budget — a failed write earlier left it
      // that way, or the budget shrank — so evict down to the real limit now rather than waiting
      // for the next write to fail.
      await evictToBudget(budget)
    }
  }

  const message: AnalysedMessage = {
    type: 'analysed',
    requestId: request.requestId,
    payload,
    fromCache: false,
  }
  scope.postMessage(message, payloadTransfers(payload))
}

function handleRelease(request: ReleaseRequest): void {
  if (!retained.delete(request.sourceSha256)) {
    // Nothing retained: either evicted already, or an `open` for this source is
    // still parsing — mark it so the open does not retain a closed table.
    releasedBeforeOpen.add(request.sourceSha256)
  }
  scope.postMessage({ type: 'released', requestId: request.requestId })
}

scope.addEventListener('message', (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data
  if (request.type === 'cancel') {
    for (const requestId of request.requestIds) {
      if (inFlight.has(requestId)) cancelled.add(requestId)
    }
    return
  }

  inFlight.add(request.requestId)
  const run = async (): Promise<void> => {
    switch (request.type) {
      case 'open':
        return handleOpen(request)
      case 'analyse':
        return handleAnalyse(request)
      case 'release':
        return handleRelease(request)
    }
  }
  run()
    .catch((error: unknown) => reportError(request.requestId, error))
    .finally(() => {
      inFlight.delete(request.requestId)
      cancelled.delete(request.requestId)
    })
})
