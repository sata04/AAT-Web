/**
 * The error taxonomy of the analysis engine.
 *
 * Every failure the engine raises carries a stable machine-readable `code` plus
 * structured `details`. The message strings here are developer-facing English:
 * the UI layer renders the user-visible text from the code and the details, so
 * a Japanese researcher sees a Japanese message without the engine hard-coding
 * one language into the numerical core.
 *
 * The codes mirror the reference exception hierarchy in
 * `reference/python/core/exceptions.py`:
 *
 *   DataLoadError          -> CSV_DECODE_FAILED, CSV_PARSE_FAILED, CSV_EMPTY
 *   ColumnNotFoundError    -> COLUMN_NOT_FOUND
 *   DataProcessingError    -> COLUMN_NOT_NUMERIC, TIME_COLUMN_EMPTY, ...
 *   (no desktop equivalent) -> ANALYSIS_TOO_LARGE, see docs/numerical-compatibility.md
 */

export type AnalysisErrorCode =
  /** Neither UTF-8 nor Shift_JIS could decode the file. */
  | 'CSV_DECODE_FAILED'
  /** The CSV text is structurally unusable (ragged rows, unterminated quotes). */
  | 'CSV_PARSE_FAILED'
  /** The file holds no header row, or no data rows at all. */
  | 'CSV_EMPTY'
  /** A configured column name is absent from the file. */
  | 'COLUMN_NOT_FOUND'
  /** A selected column holds no numeric value at all. */
  | 'COLUMN_NOT_NUMERIC'
  /** Both accelerometers were disabled in the configuration. */
  | 'NO_SENSOR_ENABLED'
  /** The time column has no rows. */
  | 'TIME_COLUMN_EMPTY'
  /** The time column has rows but not a single finite value. */
  | 'TIME_COLUMN_INVALID'
  /** `gravityConstant` is zero, so the gravity conversion would divide by zero. */
  | 'GRAVITY_CONSTANT_ZERO'
  /** Neither sensor produced a series to filter. */
  | 'NO_SENSOR_DATA'
  /** A window size or sampling rate that cannot describe a real window. */
  | 'ANALYSIS_PARAMETER_INVALID'
  /** The exact-computation budget would be exceeded (deliberate divergence). */
  | 'ANALYSIS_TOO_LARGE'

/** Structured, serialisable context attached to an error. */
export type AnalysisErrorDetails = Readonly<Record<string, string | number | boolean | readonly string[]>>

/** Base class for every failure raised by the analysis engine. */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode
  readonly details: AnalysisErrorDetails

  constructor(code: AnalysisErrorCode, message: string, details: AnalysisErrorDetails = {}) {
    super(message)
    this.name = 'AnalysisError'
    this.code = code
    this.details = details
  }
}

/** The bytes are not valid UTF-8 and not valid Shift_JIS either. */
export class CsvDecodeError extends AnalysisError {
  constructor(message: string, details: AnalysisErrorDetails = {}) {
    super('CSV_DECODE_FAILED', message, details)
    this.name = 'CsvDecodeError'
  }
}

/** The CSV text cannot be turned into a rectangular table. */
export class CsvParseError extends AnalysisError {
  constructor(code: 'CSV_PARSE_FAILED' | 'CSV_EMPTY', message: string, details: AnalysisErrorDetails = {}) {
    super(code, message, details)
    this.name = 'CsvParseError'
  }
}

/**
 * A configured column is not in the file.
 *
 * Carries both the missing names and the full list of available ones, because
 * the desktop application answers this error by reopening the column-selection
 * dialog, and the web UI does the same — it needs the candidates to offer.
 */
export class ColumnNotFoundError extends AnalysisError {
  readonly missingColumns: readonly string[]
  readonly availableColumns: readonly string[]

  constructor(missingColumns: readonly string[], availableColumns: readonly string[]) {
    super('COLUMN_NOT_FOUND', `Required columns are missing: ${missingColumns.join(', ')}`, {
      missingColumns,
      availableColumns,
    })
    this.name = 'ColumnNotFoundError'
    this.missingColumns = missingColumns
    this.availableColumns = availableColumns
  }
}

/** A failure while turning a parsed table into analysable series. */
export class DataProcessingError extends AnalysisError {
  constructor(
    code: Extract<
      AnalysisErrorCode,
      | 'COLUMN_NOT_NUMERIC'
      | 'NO_SENSOR_ENABLED'
      | 'TIME_COLUMN_EMPTY'
      | 'TIME_COLUMN_INVALID'
      | 'GRAVITY_CONSTANT_ZERO'
      | 'NO_SENSOR_DATA'
    >,
    message: string,
    details: AnalysisErrorDetails = {},
  ) {
    super(code, message, details)
    this.name = 'DataProcessingError'
  }
}
