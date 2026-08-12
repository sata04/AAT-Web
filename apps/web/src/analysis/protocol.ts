/**
 * The message contract between the main thread and the analysis Web Worker.
 *
 * Two shapes matter here beyond the obvious request/response pairing:
 *
 *   - Opening a file and analysing it are separate messages. Column detection
 *     can be ambiguous, and the desktop answers that by asking the user before
 *     computing anything (`ColumnSelectorDialog`). Splitting the messages lets
 *     the worker parse once, hold the table, and analyse whichever mapping comes
 *     back — instead of parsing again after the dialog closes.
 *
 *   - Every numeric array in a response is a `Float64Array` whose buffer is
 *     listed as transferable. A realistic run is tens of megabytes; copying it
 *     across the boundary on every analysis is the kind of allocation that makes
 *     a tab stutter for no reason.
 */

import type {
  AnalysisWarning,
  CsvEncoding,
  DetectedColumns,
  GQualityRow,
  SyncResult,
  WindowStatistics,
} from '@aat/analysis-core'
import type { AnalysisConfig } from '@aat/shared'

/** Which columns of a particular CSV carry what. Not part of the analysis config. */
export interface ColumnMapping {
  timeColumn: string
  innerColumn: string
  dragColumn: string
  useInner: boolean
  useDrag: boolean
}

export interface OpenRequest {
  type: 'open'
  requestId: string
  filename: string
  /** Transferred, so the caller must not touch it afterwards. */
  bytes: ArrayBuffer
}

export interface AnalyseRequest {
  type: 'analyse'
  requestId: string
  /** Identifies the table the worker retained from `open`. */
  sourceSha256: string
  filename: string
  config: AnalysisConfig
  mapping: ColumnMapping
  /** Skip the sweep — `auto_calculate_g_quality` is off, or the user deferred it. */
  skipGQuality: boolean
  /** Read and write the IndexedDB cache. Off re-runs the numbers unconditionally. */
  useCache: boolean
}

/** Drop a retained table once its dataset is closed. */
export interface ReleaseRequest {
  type: 'release'
  requestId: string
  sourceSha256: string
}

export type AnalysisWorkerRequest = OpenRequest | AnalyseRequest | ReleaseRequest

/** What `open` learned about the file, before any analysis. */
export interface OpenedSource {
  sourceSha256: string
  filename: string
  encoding: CsvEncoding
  columnNames: string[]
  detected: DetectedColumns
  rowCount: number
  /**
   * The mapping detection is confident about, or `null` when the user must
   * choose. Null means: candidates were missing or ambiguous, so show the
   * column selector rather than guessing.
   */
  suggestedMapping: ColumnMapping | null
  /** Why a mapping could not be suggested, for the dialog's explanatory text. */
  ambiguity: ColumnAmbiguity | null
}

export type ColumnAmbiguity =
  /** No column looked like a time axis. */
  | 'NO_TIME_CANDIDATE'
  /** No column looked like acceleration. */
  | 'NO_ACCELERATION_CANDIDATE'
  /** More than one plausible answer; the desktop asks in this case too. */
  | 'MULTIPLE_CANDIDATES'
  /** Only one acceleration series exists, so one sensor has to be disabled. */
  | 'SINGLE_ACCELERATION_CANDIDATE'

/** One sensor's results, all at full resolution. */
export interface SensorResult {
  present: boolean
  /** Sync-adjusted time for every row of the file. */
  time: Float64Array
  /** Gravity level for every row. */
  gravity: Float64Array
  /** The microgravity segment only. */
  filteredTime: Float64Array
  filteredGravity: Float64Array
  /**
   * Acceleration in m/s^2 over the filtered segment, sign-corrected exactly as
   * the pipeline corrected it. The desktop writes this as its own worksheet.
   */
  filteredAcceleration: Float64Array
  startIndex: number | null
  endIndex: number | null
}

export interface AnalysisPayload {
  sourceSha256: string
  filename: string
  encoding: CsvEncoding
  columnNames: string[]
  detected: DetectedColumns
  mapping: ColumnMapping
  inner: SensorResult
  drag: SensorResult
  sync: SyncResult
  statistics: { inner: WindowStatistics; drag: WindowStatistics }
  gQuality: GQualityRow[]
  gQualityComputed: boolean
  warnings: AnalysisWarning[]
  sampleCount: number
  /** ISO 8601, recorded when the numbers were computed rather than when read back. */
  analysisTimestamp: string
}

export type AnalysisStage =
  | 'decoding'
  | 'parsing'
  | 'detecting'
  | 'loading'
  | 'filtering'
  | 'statistics'
  | 'gquality'
  | 'caching'

export interface ProgressMessage {
  type: 'progress'
  requestId: string
  stage: AnalysisStage
  /** 0-100 across the whole request, so a single bar can show it. */
  percent: number
}

export interface OpenedMessage {
  type: 'opened'
  requestId: string
  source: OpenedSource
}

export interface AnalysedMessage {
  type: 'analysed'
  requestId: string
  payload: AnalysisPayload
  /** True when the numbers came from IndexedDB rather than being recomputed. */
  fromCache: boolean
}

export interface ReleasedMessage {
  type: 'released'
  requestId: string
}

/**
 * A failure, flattened to something structured-cloneable.
 *
 * `Error` subclasses do not survive `postMessage` with their class identity, so
 * the code travels as a field. `availableColumns` is carried because a missing
 * column is answered by reopening the column selector, which needs the
 * candidates.
 */
export interface ErrorMessage {
  type: 'error'
  requestId: string
  code: string
  message: string
  missingColumns?: string[]
  availableColumns?: string[]
}

export type AnalysisWorkerResponse =
  | ProgressMessage
  | OpenedMessage
  | AnalysedMessage
  | ReleasedMessage
  | ErrorMessage
