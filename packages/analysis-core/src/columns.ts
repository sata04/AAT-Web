/**
 * Port of `detect_columns()` from `reference/python/core/data_processor.py`.
 *
 * The function proposes which columns *could* be the time axis and which could
 * be acceleration, for the column-selection dialog to offer. It never decides
 * anything on its own, so being generous is correct — but being generous in the
 * same way as the desktop application is what keeps a saved configuration
 * meaningful across the two implementations.
 */

import type { CsvTable } from './csv.ts'
import { isNumericColumn } from './csv.ts'

/**
 * Python's `\b` is Unicode-aware; JavaScript's is not.
 *
 * `re` on a `str` treats every alphanumeric character as a word character, so in
 * `"...(m/s²)"` the `²` (category No, and `'²'.isalnum() == True`) makes `\bs\b`
 * *fail*. JavaScript's `\b` only knows `[A-Za-z0-9_]`, would see `²` as a
 * boundary, and would match — classifying both acceleration columns of the
 * `japanese_headers_utf8` fixture as time candidates, which the reference does
 * not. The lookaround pair below restores Python's definition:
 * `\w == [\p{L}\p{N}_]`.
 */
const WORD = '[\\p{L}\\p{N}_]'
const NOT_AFTER_WORD = `(?<!${WORD})`
const NOT_BEFORE_WORD = `(?!${WORD})`

/** `re.compile(r"\btime|\bsec\b|\bt\b|\bs\b|時間|秒", re.IGNORECASE)` */
const TIME_PATTERN = new RegExp(
  `${NOT_AFTER_WORD}time|${NOT_AFTER_WORD}sec${NOT_BEFORE_WORD}|${NOT_AFTER_WORD}t${NOT_BEFORE_WORD}|` +
    `${NOT_AFTER_WORD}s${NOT_BEFORE_WORD}|時間|秒`,
  'iu',
)

/** `re.compile(r"\bacc|\bacceleration|\ba\b|\bg\b|加速度", re.IGNORECASE)` */
const ACCELERATION_PATTERN = new RegExp(
  `${NOT_AFTER_WORD}acc|${NOT_AFTER_WORD}acceleration|${NOT_AFTER_WORD}a${NOT_BEFORE_WORD}|` +
    `${NOT_AFTER_WORD}g${NOT_BEFORE_WORD}|加速度`,
  'iu',
)

export interface DetectedColumns {
  /** Columns that could carry the time axis, in file order. */
  time: string[]
  /** Columns that could carry acceleration, in file order. */
  acceleration: string[]
}

/**
 * Propose time and acceleration column candidates for a parsed table.
 *
 * Name matching first; then, for whichever list came back empty, numeric columns
 * as a fallback. The asymmetry between the two fallbacks is deliberate in the
 * reference and is preserved here — see the comment on the acceleration branch.
 */
export function detectColumns(table: CsvTable): DetectedColumns {
  let timeColumns: string[] = []
  let accelerationColumns: string[] = []

  for (const column of table.columnNames) {
    const lowered = column.toLowerCase().trim()
    if (TIME_PATTERN.test(lowered)) timeColumns.push(column)
    if (ACCELERATION_PATTERN.test(lowered)) accelerationColumns.push(column)
  }

  const namedTimeColumns = [...timeColumns]
  const numericColumns = table.columns.filter(isNumericColumn).map((column) => column.name)

  if (timeColumns.length === 0) {
    timeColumns = numericColumns.filter((column) => !accelerationColumns.includes(column))
    if (timeColumns.length === 0) timeColumns = [...numericColumns]
  }

  if (accelerationColumns.length === 0) {
    // Exclude only the columns matched by *name* as time, never the ones the
    // numeric fallback just put into `timeColumns`. Excluding those as well
    // leaves no acceleration candidate at all for a file whose headers match
    // nothing (X1, X2, X3), and the user can then neither pick columns nor open
    // the file. The reference source calls this out explicitly.
    accelerationColumns = numericColumns.filter((column) => !namedTimeColumns.includes(column))
    if (accelerationColumns.length > 1) {
      // Common layout: the first column is the time axis, so drop it.
      accelerationColumns = accelerationColumns.slice(1)
    }
  }

  return { time: timeColumns, acceleration: accelerationColumns }
}
