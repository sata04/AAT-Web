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
 * `mangle_dupe_cols`, ported from the header-dedup loop pandas actually runs
 * (`python_parser._infer_columns`, shared by the C and Python engines — not the
 * near-identical `io.common.dedup_names`, which lacks the lookahead). The first
 * copy keeps the name and each repeat becomes `name.<k>` counting occurrences of
 * the *original* name; a candidate that already appears in the header row —
 * whether at a not-yet-processed position or as a name produced by an earlier
 * rename — is skipped rather than suffixed further. That is why `a, a.1, a`
 * becomes `a, a.1, a.2`, not `a.1.1` (the literal `a.1` occupies the first
 * candidate).
 *
 * Blank header cells are renamed `Unnamed: {position}` and mangled only after
 * every named column, so a real column name is never displaced by a blank cell.
 *
 * Without this a duplicated header would silently shadow the earlier column, and
 * a configuration naming that column would analyse the wrong data.
 */
function deduplicateHeader(header: readonly string[]): string[] {
  const names = header.map((name, index) => (name === '' ? `Unnamed: ${index}` : name))
  // The names each position currently holds — the `col in this_columns`
  // membership check, which sees unprocessed originals and earlier renames.
  const present = new Map<string, number>()
  for (const name of names) present.set(name, (present.get(name) ?? 0) + 1)
  const counts = new Map<string, number>()
  const namedFirst = names
    .map((_, index) => index)
    .filter((index) => header[index] !== '')
    .concat(names.map((_, index) => index).filter((index) => header[index] === ''))
  for (const index of namedFirst) {
    const original = names[index] as string
    let name = original
    let seen = counts.get(name) ?? 0
    while (seen > 0) {
      counts.set(original, seen + 1)
      name = `${original}.${seen}`
      seen = present.has(name) ? seen + 1 : (counts.get(name) ?? 0)
    }
    names[index] = name
    if (name !== original) {
      const left = (present.get(original) ?? 1) - 1
      if (left > 0) {
        present.set(original, left)
      } else {
        present.delete(original)
      }
      present.set(name, 1)
    }
    counts.set(name, seen + 1)
  }
  return names
}

/**
 * pandas' C tokenizer skips physically blank records, but keeps `""` as a
 * missing observation. Papa's empty-line modes both discard that quoted record,
 * so skip blank records before tokenising and normalise only unquoted newlines.
 */
function normaliseRecords(text: string, delimiter: string): string {
  const records: string[] = []
  // The C tokenizer's blank-line whitespace is ASCII space/tab, not JS trim's
  // Unicode whitespace. A tab delimiter starts a field even on a tab-only row.
  const blankRecord = delimiter === '\t' ? /^ *$/ : /^[ \t]*$/
  let start = 0
  let quoted = false
  let fieldStart = true
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') index++
        else quoted = false
      }
    } else if (character === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (character === '\r' || character === '\n') {
      const record = text.slice(start, index)
      if (!blankRecord.test(record)) records.push(record)
      if (character === '\r' && text[index + 1] === '\n') index++
      start = index + 1
      fieldStart = true
    } else {
      // A quote inside an unquoted field is literal text and must not swallow
      // the next record separator.
      fieldStart = character === delimiter
    }
  }
  const last = text.slice(start)
  if (!blankRecord.test(last)) records.push(last)
  return records.join('\n')
}

/** Validate a candidate before letting it replace an apparent comma table. */
function hasCleanLayout(parsed: Papa.ParseResult<string[]>): boolean {
  const width = parsed.data[0]?.length ?? 0
  if (width < 2 || parsed.errors.length > 0) return false
  const body = parsed.data.slice(1)
  const expected = body[0]?.length === width + 1 ? width + 1 : width
  return body.every((row) => row.length <= expected)
}

/** A header comma alone is weak evidence when the entire body lacks commas. */
function hasOnlySingleFieldBody(parsed: Papa.ParseResult<string[]>): boolean {
  return (
    parsed.errors.length === 0 &&
    parsed.data.length > 1 &&
    parsed.data.slice(1).every((row) => row.length === 1)
  )
}

/**
 * Commas inside quoted alternative-delimiter headers are metadata, not evidence
 * of a comma layout. Unquoted header commas favor comma precedence even when
 * later rows contain malformed quoting or too many fields.
 */
function hasUnquotedHeaderComma(records: string, delimiter: string): boolean {
  let quoted = false
  let fieldStart = true
  for (let index = 0; index < records.length; index++) {
    const character = records[index]
    if (quoted) {
      if (character === '"') {
        if (records[index + 1] === '"') index++
        else quoted = false
      }
    } else if (character === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (character === ',') {
      return true
    } else if (character === '\n') {
      return false
    } else {
      fieldStart = character === delimiter
    }
  }
  return false
}

/** Sniff without discarding any records from the eventual, explicit parse. */
function sniffDelimiter(source: string): string {
  // Empty quoted records lower Papa's average field count below its 1.99
  // threshold. Ignore those for sniffing only; normaliseRecords preserves them.
  const preview = Papa.parse<string[]>(source, { skipEmptyLines: true, preview: 10 })
  if (!preview.errors.some((error) => error.code === 'UndetectableDelimiter')) {
    return preview.meta.delimiter
  }
  // Many short records can defeat the average even with empty lines excluded.
  // In that case use the first header with multiple fields, tokenising each
  // candidate with its own quote boundaries and record separators.
  for (const delimiter of ['\t', '|', ';', '\x1e', '\x1f']) {
    const header = Papa.parse<string[]>(normaliseRecords(source, delimiter), {
      delimiter,
      newline: '\n',
      preview: 1,
    })
    if ((header.data[0]?.length ?? 0) > 1 && !header.errors.some((error) => error.type === 'Quotes')) {
      return delimiter
    }
  }
  return ','
}

/**
 * Parse CSV text into a table of raw cell text.
 *
 * The first non-blank row is the header. Blank lines are dropped, matching
 * pandas' `skip_blank_lines=True`; a row with fewer fields than the header is
 * padded with empty cells, which pandas reads as missing values. An extra
 * leading field in the first body row establishes an implicit index for all
 * rows. More than one implicit index field is unsupported.
 */
export function parseCsvText(text: string): CsvTable {
  const source = text.replace(/^\uFEFF/, '')
  const records = normaliseRecords(source, ',')
  if (records === '') throw new CsvParseError('CSV_EMPTY', 'The file contains no header row.')
  const options: Papa.ParseConfig<string[]> & { worker: false } = {
    header: false,
    // Raw text only: every conversion has to go through the pandas-compatible
    // converter, so papaparse must not guess types of its own.
    dynamicTyping: false,
    newline: '\n',
    skipEmptyLines: false,
    worker: false,
  }
  // data_processor.py reads comma CSVs by default. Genuine comma separators in
  // the header establish that layout independently of any errors in its data.
  const comma = Papa.parse<string[]>(records, { ...options, delimiter: ',' })
  const delimiter = sniffDelimiter(source)
  let parsed = comma
  if (delimiter !== ',') {
    const alternativeRecords = normaliseRecords(source, delimiter)
    const alternative = Papa.parse<string[]>(alternativeRecords, { ...options, delimiter })
    // A one-column comma header supplies no competing layout: keep the
    // alternative's errors so a malformed TSV cannot become a one-column CSV.
    // Otherwise require both positive header evidence and a clean alternative.
    // Short alternative rows are fine — pandas pads them like short CSV rows.
    // With an unquoted header comma, a two-field alternative header is itself
    // ambiguous with a comma table whose second column carries the delimiter —
    // comma precedence wins there (the desktop's default). Three or more
    // alternative fields can only arise from real delimiters, and at least one
    // data row must actually carry the delimiter — header width alone cannot
    // prove a sparse table is not comma-separated. Delimiter-free rows still
    // count: pandas pads them as short records.
    if (
      (comma.data[0]?.length ?? 0) < 2 ||
      (hasCleanLayout(alternative) &&
        (!hasUnquotedHeaderComma(records, delimiter) ||
          (hasOnlySingleFieldBody(comma) &&
            (alternative.data[0]?.length ?? 0) > 2 &&
            alternative.data.slice(1).some((row) => row.length > 1))))
    ) {
      parsed = alternative
    }
  }

  const quoteError = parsed.errors.find((error) => error.type === 'Quotes')
  if (quoteError !== undefined) {
    throw new CsvParseError('CSV_PARSE_FAILED', `Malformed quoting in the CSV: ${quoteError.message}`, {
      row: quoteError.row ?? -1,
    })
  }

  // pandas' C tokenizer terminates a field at the first NUL. Truncate the
  // token, not the record, so later fields and sample alignment are preserved.
  const rows = parsed.data.map((row) =>
    row.map((cell) => {
      const nul = cell.indexOf('\0')
      return nul < 0 ? cell : cell.slice(0, nul)
    }),
  )
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
 * pandas infers an index from the first body row, then consumes that index
 * field even in short rows, padding the end with missing values. A later wide
 * row cannot retroactively establish an index.
 */
function pivotRows(rows: string[][], header: readonly string[], rowCount: number): string[][] {
  const cells: string[][] = header.map(() => new Array<string>(rowCount))
  const indexFields = rows[1]?.length === header.length + 1 ? 1 : 0

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = rows[rowIndex + 1] as string[]
    if (row.length > header.length + indexFields) {
      throw new CsvParseError(
        'CSV_PARSE_FAILED',
        `Row ${rowIndex + 2} has ${row.length} fields but the header declares ${header.length}.`,
        { row: rowIndex + 2, fields: row.length, expected: header.length },
      )
    }
    for (let columnIndex = 0; columnIndex < header.length; columnIndex++) {
      ;(cells[columnIndex] as string[])[rowIndex] = row[columnIndex + indexFields] ?? ''
    }
  }

  return cells
}

/** The boolean spellings the C parser accepts; a bool column is numeric to pandas. */
const BOOLEAN_TOKENS: ReadonlySet<string> = new Set(['True', 'TRUE', 'true', 'False', 'FALSE', 'false'])
const INTEGER_TOKEN = /^[\t\n\v\f\r ]*[+-]?\d+[\t\n\v\f\r ]*$/

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
  if (column.cells.length === 0) return false
  const integers = integerColumnValues(column, 'inference')
  if (integers !== null) return integers.dtype === 'int64' || integers.dtype === 'uint64'
  if (startsWithUint64Overflow(column)) return false
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
  if (booleans !== null) return booleans
  const integers = integerColumnValues(column, 'numeric')
  if (integers !== null && integers.dtype !== 'str') {
    const { values, missingCount } = integers
    if (values.length > 0 && missingCount === values.length) {
      throw new DataProcessingError(
        'COLUMN_NOT_NUMERIC',
        `Column '${column.name}' contains no numeric data.`,
        {
          column: column.name,
          rows: values.length,
        },
      )
    }
    return { values, missingCount, coercedCount: 0 }
  }
  return coerceNumericCells(
    column,
    integers?.dtype === 'str' || (integers === null && startsWithUint64Overflow(column)),
  )
}

/**
 * pandas keeps boolean values as bool objects when missing cells require object
 * dtype. `_to_numeric_series` in data_processor.py converts those to 1/0 with
 * gaps, but boolean tokens mixed with numbers or text remain strings.
 */
function booleanColumnValues(column: CsvColumn): NumericColumn | null {
  const length = column.cells.length
  const values = new Float64Array(length)
  let missingCount = 0
  for (let index = 0; index < length; index++) {
    const cell = column.cells[index] as string
    if (isMissingToken(cell)) {
      values[index] = Number.NaN
      missingCount++
      continue
    }
    if (!BOOLEAN_TOKENS.has(cell)) return null
    values[index] = cell === 'True' || cell === 'TRUE' || cell === 'true' ? 1 : 0
  }
  if (length > 0 && missingCount === length) return null
  return { values, missingCount, coercedCount: 0 }
}

/**
 * pandas tries int64, then uint64, before its float converter. Unsigned values
 * mixed with negatives or NA remain strings. Entirely integral columns beyond
 * the 64-bit bounds become Python integer objects in pandas 3; to_numeric then
 * casts those exactly too, although their read_csv dtype is not numeric.
 */
function integerColumnValues(
  column: CsvColumn,
  stage: 'inference' | 'numeric',
): { values: Float64Array; missingCount: number; dtype: 'int64' | 'uint64' | 'object' | 'str' } | null {
  const values = new Float64Array(column.cells.length)
  let missingCount = 0
  let unsigned = false
  let negative = false
  let negativeSign = false
  let outOfRange = false
  let unsignedOverflow = false
  const sentinelIndices: number[] = []
  for (let index = 0; index < column.cells.length; index++) {
    const cell = column.cells[index] as string
    if (isMissingToken(cell)) {
      values[index] = Number.NaN
      missingCount++
      continue
    }
    if (!INTEGER_TOKEN.test(cell)) return null
    const integer = BigInt(cell)
    if (integer > 9223372036854775807n) unsigned = true
    if (integer < 0n) negative = true
    if (cell.trimStart().startsWith('-')) negativeSign = true
    if (integer < -9223372036854775808n || integer > 18446744073709551615n) outOfRange = true
    if (integer > 18446744073709551615n) unsignedOverflow = true
    if (integer === -9223372036854775808n) sentinelIndices.push(index)
    values[index] = Number(integer)
  }
  if (column.cells.length > 0 && missingCount === column.cells.length) return null
  // Signed underflow does not override a uint64/negative conflict: pandas
  // retains those cells as strings, including literal NA tokens. Positive
  // uint64 overflow instead makes an all-integral column Python int objects.
  if (unsigned && !unsignedOverflow && (missingCount > 0 || negative)) {
    return { values, missingCount, dtype: 'str' }
  }
  if (outOfRange) {
    // Defer this check until we know the whole column is integral. A later
    // decimal/text cell takes another inference path that can accept infinity.
    // read_csv's object inference probes the first nonmissing integer only;
    // to_numeric subsequently converts all objects, including later overflow.
    const firstValue = values.find((value) => !Number.isNaN(value))
    const overflows =
      stage === 'inference'
        ? firstValue !== undefined && !Number.isFinite(firstValue)
        : values.some((value) => !Number.isNaN(value) && !Number.isFinite(value))
    if (overflows) {
      throw new CsvParseError(
        'CSV_PARSE_FAILED',
        `An integer in column '${column.name}' is too large to convert to float.`,
        {
          column: column.name,
        },
      )
    }
    return { values, missingCount, dtype: 'object' }
  }
  if (unsigned) {
    // read_csv rejects even '-0' for uint64. to_numeric on those strings can
    // still infer uint64, so preserve the exact conversion but object detection.
    return { values, missingCount, dtype: negativeSign ? 'object' : 'uint64' }
  }
  if (missingCount > 0) {
    // int64-min is the C parser's sentinel only when NA forces a float cast.
    // Compare the integer itself: neighbouring integers round to the same float.
    for (const index of sentinelIndices) values[index] = Number.NaN
    missingCount += sentinelIndices.length
  }
  return { values, missingCount, dtype: 'int64' }
}

/**
 * A positive uint64 overflow before the first non-integer aborts both numeric
 * inference and NA conversion. Reversing those rows can instead yield floats
 * or strings with actual missing values, so this check must respect row order.
 */
function startsWithUint64Overflow(column: CsvColumn): boolean {
  for (const cell of column.cells) {
    if (isMissingToken(cell)) continue
    if (!INTEGER_TOKEN.test(cell)) return false
    if (BigInt(cell) > 18446744073709551615n) return true
  }
  return false
}

/**
 * `pd.to_numeric(column, errors='coerce')` on a mixed column: every cell goes
 * through `parseCell`, and unconvertible text is counted and coerced to a
 * missing value. A column with no numeric value at all is an error.
 */
function coerceNumericCells(column: CsvColumn, preserveNaStrings: boolean): NumericColumn {
  const length = column.cells.length
  const values = new Float64Array(length)
  const counts: Record<CellKind, number> = { number: 0, missing: 0, invalid: 0 }

  for (let index = 0; index < length; index++) {
    const parsed = parseCell(column.cells[index] as string)
    values[index] = parsed.value
    // Integer conflicts can leave pandas' NA spellings as literal strings.
    // to_numeric then coerces them, which must produce CELLS_COERCED warnings.
    counts[parsed.kind === 'missing' && preserveNaStrings ? 'invalid' : parsed.kind]++
  }

  if (length > 0 && counts.number === 0) {
    throw new DataProcessingError('COLUMN_NOT_NUMERIC', `Column '${column.name}' contains no numeric data.`, {
      column: column.name,
      rows: length,
    })
  }

  return { values, missingCount: counts.missing, coercedCount: counts.invalid }
}
