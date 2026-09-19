/**
 * CSV text -> table, and table column -> float64 series.
 *
 * The desktop application gets both from `pd.read_csv`. Here the two halves are
 * separate: papaparse produces the raw cell text (it is a tokenizer, and a good
 * one — quoted fields containing the delimiter, CRLF, delimiter sniffing), and
 * this module reproduces pandas' *conversion* on top of it, cell by cell,
 * through `parseCell` in `pandas-number.ts`.
 *
 * papaparse's own `worker: true` is deliberately not used: this code already
 * runs inside a dedicated Web Worker, and nesting another one would move the
 * whole file across a second structured-clone boundary for no benefit.
 */

import Papa from 'papaparse'
import { CsvParseError, DataProcessingError } from './errors.ts'
import {
  type CellKind,
  isMissingToken,
  parseCell,
  parseInfinityToken,
  parsePandasFloat,
} from './pandas-number.ts'

/** One column of raw, unconverted cell text. */
export interface CsvColumn {
  readonly name: string
  readonly cells: readonly string[]
}

/** A rectangular table of raw cell text, in file order. */
export class CsvTable {
  readonly columnNames: readonly string[]
  readonly columns: readonly CsvColumn[]
  readonly rowCount: number
  private readonly byName: Map<string, CsvColumn>

  constructor(columns: readonly CsvColumn[], rowCount: number) {
    this.columns = columns
    this.columnNames = columns.map((column) => column.name)
    this.rowCount = rowCount
    this.byName = new Map(columns.map((column) => [column.name, column]))
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  column(name: string): CsvColumn | undefined {
    return this.byName.get(name)
  }
}

/**
 * `mangle_dupe_cols` via `parsers.pyx::dedup_names`: the first copy keeps the
 * name, later copies become `.1`, `.2`, … counting occurrences *of the original
 * name*, and a generated name that itself collides keeps suffixing —
 * `a, a.1, a` becomes `a, a.1, a.1.1`, not `a.2`.
 *
 * Without this a duplicated header would silently shadow the earlier column, and
 * a configuration naming that column would analyse the wrong data.
 */
function deduplicateHeader(header: readonly string[]): string[] {
  const counts = new Map<string, number>()
  return header.map((original) => {
    let name = original
    let seen = counts.get(name) ?? 0
    while (seen > 0) {
      counts.set(name, seen + 1)
      name = `${name}.${seen}`
      seen = counts.get(name) ?? 0
    }
    counts.set(name, 1)
    return name
  })
}

/**
 * Parse CSV text into a table of raw cell text.
 *
 * The first non-blank row is the header. Blank lines are dropped, matching
 * pandas' `skip_blank_lines=True`; a row with fewer fields than the header is
 * padded with empty cells, which pandas reads as missing values. A row with
 * *more* fields than the header is an error in pandas ("Expected N fields") and
 * is an error here too — the alternative is silently analysing shifted columns.
 */
export function parseCsvText(text: string): CsvTable {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    // Raw text only: every conversion has to go through the pandas-compatible
    // converter, so papaparse must not guess types of its own.
    dynamicTyping: false,
    skipEmptyLines: true,
    worker: false,
  })

  const quoteError = parsed.errors.find((error) => error.type === 'Quotes')
  if (quoteError !== undefined) {
    throw new CsvParseError('CSV_PARSE_FAILED', `Malformed quoting in the CSV: ${quoteError.message}`, {
      row: quoteError.row ?? -1,
    })
  }

  const rows = parsed.data
  const headerRow = rows[0]
  if (headerRow === undefined || headerRow.length === 0) {
    throw new CsvParseError('CSV_EMPTY', 'The file contains no header row.')
  }

  const header = deduplicateHeader(headerRow)
  const rowCount = rows.length - 1
  const cells = pivotRows(rows, header, rowCount)
  const columns = header.map((name, index) => ({ name, cells: cells[index] as string[] }))
  return new CsvTable(columns, rowCount)
}

/**
 * Transpose the body rows into column-major cell arrays.
 *
 * A row with more fields than the header is an error in pandas ("Expected N
 * fields") and is an error here — the alternative is silently analysing shifted
 * columns. A *short* row is padded with empty cells, which pandas reads as
 * missing values.
 */
function pivotRows(rows: string[][], header: readonly string[], rowCount: number): string[][] {
  const cells: string[][] = header.map(() => new Array<string>(rowCount))

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = rows[rowIndex + 1] as string[]
    if (row.length > header.length) {
      throw new CsvParseError(
        'CSV_PARSE_FAILED',
        `Row ${rowIndex + 2} has ${row.length} fields but the header declares ${header.length}.`,
        { row: rowIndex + 2, fields: row.length, expected: header.length },
      )
    }
    for (let columnIndex = 0; columnIndex < header.length; columnIndex++) {
      ;(cells[columnIndex] as string[])[rowIndex] = row[columnIndex] ?? ''
    }
  }

  return cells
}

/** The boolean spellings the C parser accepts; a bool column is numeric to pandas. */
const BOOLEAN_TOKENS: ReadonlySet<string> = new Set(['True', 'TRUE', 'true', 'False', 'FALSE', 'false'])

/**
 * How the pandas C parser would classify one cell for dtype inference: a
 * number (including the `inf` spellings), a missing token, a boolean token, or
 * `null` for text it cannot read as any of those.
 */
function cellNumericKind(cell: string): 'missing' | 'number' | 'boolean' | null {
  if (isMissingToken(cell)) return 'missing'
  if (parsePandasFloat(cell) !== null || parseInfinityToken(cell) !== null) return 'number'
  if (BOOLEAN_TOKENS.has(cell)) return 'boolean'
  return null
}

/**
 * Would `pd.read_csv` have given this column a numeric dtype?
 *
 * `detect_columns` falls back to `pd.api.types.is_numeric_dtype`, so the answer
 * decides which columns are offered as candidates for a file whose headers say
 * nothing useful. pandas infers a numeric dtype when every cell either parses as
 * a number or reads as missing — an empty cell still leaves the column float64.
 * Booleans count as numeric too, because `is_numeric_dtype(bool)` is `True`.
 */
export function isNumericColumn(column: CsvColumn): boolean {
  const kinds = new Set(column.cells.map(cellNumericKind))
  if (kinds.has(null)) return false
  // bool dtype can hold no NaN, so a boolean column with a missing cell — like
  // one mixing booleans and numbers — is object dtype, which is not numeric.
  return !(kinds.has('boolean') && (kinds.has('number') || kinds.has('missing')))
}

export interface NumericColumn {
  values: Float64Array
  /** Cells pandas reads as missing (blank, `NA`, `null`, ...). */
  missingCount: number
  /** Cells that held text pandas cannot read as a number, dropped by coercion. */
  coercedCount: number
}

/**
 * `_to_numeric_series` — convert a column to float64, coercing what will not convert.
 *
 * Mirrors `pd.to_numeric(column, errors='coerce').astype(float)`: unconvertible
 * text becomes a missing value rather than leaking a string into arithmetic,
 * where it would either raise on the sign inversion or, worse, compare as an
 * object and pick a wrong sync point. A column with no numeric value at all is
 * an error, so the caller can send the user back to column selection instead of
 * analysing an all-NaN series.
 */
export function toNumericColumn(column: CsvColumn): NumericColumn {
  const booleans = booleanColumnValues(column)
  if (booleans !== null) {
    return { values: booleans, missingCount: 0, coercedCount: 0 }
  }
  return coerceNumericCells(column)
}

/**
 * The all-boolean fast path: a column of pure boolean tokens is bool dtype to
 * pandas, and `pd.to_numeric` leaves it as 1.0/0.0 rather than coercing it to
 * NaN. Returns null when any cell is not a boolean token; an empty column is
 * vacuously all-boolean, which returns the same empty result the coercion path
 * would.
 */
function booleanColumnValues(column: CsvColumn): Float64Array | null {
  const length = column.cells.length
  const values = new Float64Array(length)
  for (let index = 0; index < length; index++) {
    const cell = column.cells[index] as string
    if (!BOOLEAN_TOKENS.has(cell)) return null
    values[index] = cell === 'True' || cell === 'TRUE' || cell === 'true' ? 1 : 0
  }
  return values
}

/**
 * `pd.to_numeric(column, errors='coerce')` on a mixed column: every cell goes
 * through `parseCell`, and unconvertible text is counted and coerced to a
 * missing value. A column with no numeric value at all is an error.
 */
function coerceNumericCells(column: CsvColumn): NumericColumn {
  const length = column.cells.length
  const values = new Float64Array(length)
  const counts: Record<CellKind, number> = { number: 0, missing: 0, invalid: 0 }

  for (let index = 0; index < length; index++) {
    const parsed = parseCell(column.cells[index] as string)
    values[index] = parsed.value
    counts[parsed.kind]++
  }

  if (length > 0 && counts.number === 0) {
    throw new DataProcessingError('COLUMN_NOT_NUMERIC', `Column '${column.name}' contains no numeric data.`, {
      column: column.name,
      rows: length,
    })
  }

  return { values, missingCount: counts.missing, coercedCount: counts.invalid }
}
