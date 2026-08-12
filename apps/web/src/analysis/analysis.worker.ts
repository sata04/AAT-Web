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
  AnalysisError,
  calculateGQuality,
  calculateStatistics,
  ColumnNotFoundError,
  type CsvTable,
  decodeCsv,
  detectColumns,
  EMPTY_WINDOW_STATISTICS,
  filterData,
  loadAndProcessData,
  parseCsvText,
  toNumericColumn,
} from '@aat/analysis-core'
import type { AnalysisConfig } from '@aat/shared'
import { configHash, sha256Hex } from '@aat/shared'
import { readCache, writeCache } from '../cache/analysis-cache.ts'
import { ANALYSIS_ENGINE_VERSION } from '../app/version.ts'
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
    payload.inner.filteredAcceleration,
    payload.drag.time,
    payload.drag.gravity,
    payload.drag.filteredTime,
    payload.drag.filteredGravity,
    payload.drag.filteredAcceleration,
  ])
}

function approximateBytes(payload: AnalysisPayload): number {
  let total = 0
  for (const sensor of [payload.inner, payload.drag]) {
    total += sensor.time.byteLength
    total += sensor.gravity.byteLength
    total += sensor.filteredTime.byteLength
    total += sensor.filteredGravity.byteLength
    total += sensor.filteredAcceleration.byteLength
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
    // Named errors from the statistics module (AnalysisParameterError,
    // AnalysisSizeError) reach here; the name is the most specific thing they
    // carry, so it becomes the code rather than being flattened to INTERNAL.
    message.code = error.name
    message.message = error.message
  }

  scope.postMessage(message)
}

/**
 * `SHA-256` of the source bytes.
 *
 * Content, not filename or timestamp: a renamed file is the same data and a
 * touched file is not different data. The same digest identifies the retained
 * table, the cache entry and the cloud snapshot's provenance.
 */
async function hashSource(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function handleOpen(request: OpenRequest): Promise<void> {
  const bytes = new Uint8Array(request.bytes)
  progress(request.requestId, 'decoding', 5)
  const sourceSha256 = await hashSource(bytes)

  const { text, encoding } = decodeCsv(bytes)
  progress(request.requestId, 'parsing', 20)

  const table = parseCsvText(text)
  progress(request.requestId, 'detecting', 45)

  const detected = detectColumns(table)
  retain(sourceSha256, { table, filename: request.filename, encoding })

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
 * Reconstruct a sensor's acceleration over its filtered segment.
 *
 * The pipeline returns gravity, not acceleration, and the desktop's Excel export
 * has an Acceleration Data worksheet. Multiplying gravity back by the gravity
 * constant would be off by a rounding step per sample, so the column is re-read
 * and put through the same two transformations `loadAndProcessData` applies:
 * samples whose timestamp is unusable are masked, and the Inner Capsule is
 * negated when `invert_inner_acceleration` is set.
 *
 * Kept adjacent to the call site rather than hidden away, precisely because it
 * duplicates pipeline behaviour and has to be re-checked if that behaviour
 * changes.
 */
function readFilteredAcceleration(
  table: CsvTable,
  columnName: string,
  time: Float64Array,
  invert: boolean,
  startIndex: number | null,
  endIndex: number | null,
): Float64Array {
  if (startIndex === null || endIndex === null) return new Float64Array(0)
  const column = table.column(columnName)
  if (column === undefined) return new Float64Array(0)

  const values = toNumericColumn(column).values
  const length = endIndex - startIndex + 1
  if (length <= 0) return new Float64Array(0)

  const slice = new Float64Array(length)
  for (let offset = 0; offset < length; offset++) {
    const index = startIndex + offset
    const timestamp = time[index]
    const value = values[index]
    if (timestamp === undefined || value === undefined || !Number.isFinite(timestamp)) {
      slice[offset] = Number.NaN
      continue
    }
    slice[offset] = invert ? -value : value
  }
  return slice
}

const EMPTY_SENSOR: SensorResult = {
  present: false,
  time: new Float64Array(0),
  gravity: new Float64Array(0),
  filteredTime: new Float64Array(0),
  filteredGravity: new Float64Array(0),
  filteredAcceleration: new Float64Array(0),
  startIndex: null,
  endIndex: null,
}

function emptySensor(): SensorResult {
  // A fresh object each time: these arrays get transferred, and a shared
  // constant would be detached on first use. Zero-length buffers are excluded
  // from the transfer list as well, but the object itself must not be aliased.
  return { ...EMPTY_SENSOR }
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
  const engineConfig = {
    timeColumn: request.mapping.timeColumn,
    accelerationColumnInnerCapsule: request.mapping.innerColumn,
    accelerationColumnDragShield: request.mapping.dragColumn,
    useInnerAcceleration: request.mapping.useInner,
    useDragAcceleration: request.mapping.useDrag,
    samplingRate: request.config.sampling_rate,
    gravityConstant: request.config.gravity_constant,
    accelerationThreshold: request.config.acceleration_threshold,
    endGravityLevel: request.config.end_gravity_level,
    windowSize: request.config.window_size,
    gQualityStart: request.config.g_quality_start,
    gQualityEnd: request.config.g_quality_end,
    gQualityStep: request.config.g_quality_step,
    minSecondsAfterStart: request.config.min_seconds_after_start,
    invertInnerAcceleration: request.config.invert_inner_acceleration,
  }

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

  const timeColumn = table.column(engineConfig.timeColumn)
  const rawTime = timeColumn === undefined ? new Float64Array(0) : toNumericColumn(timeColumn).values

  const inner: SensorResult = request.mapping.useInner
    ? {
        present: filtered.inner.gravity.length > 0,
        time: loaded.inner.time,
        gravity: loaded.inner.gravity,
        filteredTime: filtered.inner.time,
        filteredGravity: filtered.inner.gravity,
        filteredAcceleration: readFilteredAcceleration(
          table,
          engineConfig.accelerationColumnInnerCapsule,
          rawTime,
          engineConfig.invertInnerAcceleration,
          filtered.inner.startIndex,
          filtered.inner.endIndex,
        ),
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
        filteredAcceleration: readFilteredAcceleration(
          table,
          engineConfig.accelerationColumnDragShield,
          rawTime,
          false,
          filtered.drag.startIndex,
          filtered.drag.endIndex,
        ),
        startIndex: filtered.drag.startIndex,
        endIndex: filtered.drag.endIndex,
      }
    : emptySensor()

  const gQuality = request.skipGQuality
    ? { rows: [], warnings: [] }
    : calculateGQuality(filtered, engineConfig, (update) => {
        // The sweep dominates the wall clock, so it owns the tail of the bar.
        progress(request.requestId, 'gquality', 65 + Math.round(update.percent * 0.3))
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
    statistics,
    gQuality: gQuality.rows,
    gQualityComputed: !request.skipGQuality,
    warnings: [...loaded.warnings, ...filtered.warnings, ...gQuality.warnings],
    sampleCount: loaded.sampleCount,
    analysisTimestamp: new Date().toISOString(),
  }

  if (request.useCache) {
    progress(request.requestId, 'caching', 97)
    // Written before the transfer: after `postMessage` the buffers are detached
    // and there is nothing left here to store.
    await writeCache(cacheParts, request.filename, payload, approximateBytes(payload))
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
  retained.delete(request.sourceSha256)
  scope.postMessage({ type: 'released', requestId: request.requestId })
}

scope.addEventListener('message', (event: MessageEvent<AnalysisWorkerRequest>) => {
  const request = event.data
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
  run().catch((error: unknown) => reportError(request.requestId, error))
})
