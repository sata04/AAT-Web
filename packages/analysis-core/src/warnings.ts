/**
 * Non-fatal findings raised while loading and filtering.
 *
 * The desktop application writes these to a log file that nobody reads. Here
 * they are values: they travel with the result and end up in the provenance
 * record attached to an export, so a figure carries the reasons to distrust it.
 *
 * Every warning has a stable `code` and structured `details`. The `message` is
 * a developer-facing English rendering; the UI localises from the code, exactly
 * as with `AnalysisError`.
 */

export type AnalysisWarningCode =
  /** Cells in a selected column could not be read as numbers and became missing. */
  | 'CELLS_COERCED'
  /** The time column holds NaN or +/-Infinity samples. */
  | 'TIME_NON_FINITE_SAMPLES'
  /** Acceleration samples were masked because their timestamp is unusable. */
  | 'TIME_ROWS_MASKED'
  /** The time axis steps backwards. */
  | 'TIME_NOT_MONOTONIC'
  /** The time axis repeats a timestamp. */
  | 'TIME_DUPLICATE_TIMESTAMPS'
  /** The observed sample interval disagrees with the configured sampling rate. */
  | 'SAMPLING_RATE_MISMATCH'
  /** Sample spacing is uneven, so a window measured in seconds is approximate. */
  | 'SAMPLING_INTERVAL_UNEVEN'
  /** No sample fell below the sync threshold; the first sample was used. */
  | 'SYNC_POINT_NOT_FOUND'
  /** Inner Capsule had no sync point and borrowed the Drag Shield's. */
  | 'SYNC_POINT_BORROWED'
  /** Fewer samples than one analysis window. */
  | 'DATA_SHORTER_THAN_WINDOW'
  /** No sample at or after t = 0; filtering started at the first sample. */
  | 'START_INDEX_NOT_FOUND'
  /** No sample at or after the minimum-seconds point; the start index was used. */
  | 'MIN_TIME_INDEX_NOT_FOUND'
  /** The end gravity level is never reached; the last sample was used. */
  | 'END_LEVEL_NOT_REACHED'
  /** A G-quality window exceeded the exact-computation budget and was skipped. */
  | 'GQUALITY_WINDOW_TOO_LARGE'
  /** The G-quality sweep produced nothing because there is too little data. */
  | 'GQUALITY_SKIPPED'

/** Which channel a warning is about, where that is meaningful. */
export type SensorId = 'inner' | 'drag'

export type AnalysisWarningDetails = Readonly<Record<string, string | number | boolean>>

export interface AnalysisWarning {
  code: AnalysisWarningCode
  message: string
  details: AnalysisWarningDetails
}

export function warning(
  code: AnalysisWarningCode,
  message: string,
  details: AnalysisWarningDetails = {},
): AnalysisWarning {
  return { code, message, details }
}
