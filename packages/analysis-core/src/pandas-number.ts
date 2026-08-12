/**
 * Bit-exact reimplementation of the float converter `pandas.read_csv` uses by default.
 *
 * This module exists because `Number(text)` is *not* what pandas does, and the
 * difference is visible in the golden fixtures. `read_csv`'s `float_precision`
 * defaults to the "ordinary" converter `precise_xstrtod`
 * (`pandas/_libs/src/parser/tokenizer.c`), which accumulates the significant
 * digits into a double and then scales by a power of ten from a static table.
 * That is not the correctly-rounded result a round-trip parser produces:
 *
 *   text                  Number(text) / Python float()   pandas read_csv
 *   -9.601626439999999    -9.601626439999999              -9.60162644
 *
 * One unit in the last place — which then propagates through the gravity
 * division and can flip which window wins the minimum-standard-deviation
 * search. Reproducing the reference results bit-for-bit therefore means
 * reproducing the reference *parser*, not just the reference arithmetic.
 * Measured against the goldens: `Number()` mismatches 2867 of 3000 samples on
 * `normal_two_sensor_utf8`; this implementation mismatches none.
 *
 * Reference: pandas 3.0.5 (`reference/python/requirements.txt`),
 * `precise_xstrtod()` with `max_digits = 17`, `decimal = '.'`, `sci = 'E'`,
 * `tsep = '\0'`, `skip_trailing = 1`.
 */

/** `max_digits` in `precise_xstrtod` — significant digits kept before scaling. */
const MAX_DIGITS = 17

/**
 * The static `e[]` table of the tokenizer: `1e0` through `1e308`.
 *
 * Built from numeric strings so each entry is the correctly-rounded double for
 * that power of ten, exactly like the C literals it stands in for. `10 ** k` is
 * not guaranteed to produce the same value for large `k`.
 */
const POWERS_OF_TEN = ((): Float64Array => {
  const table = new Float64Array(309)
  for (let exponent = 0; exponent <= 308; exponent++) table[exponent] = Number(`1e${exponent}`)
  return table
})()

const CHAR_PLUS = 0x2b
const CHAR_MINUS = 0x2d
const CHAR_DOT = 0x2e
const CHAR_ZERO = 0x30
const CHAR_NINE = 0x39
const CHAR_UPPER_E = 0x45
const CHAR_LOWER_E = 0x65

/** `isspace_ascii` from the tokenizer. */
function isAsciiSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d)
}

function isAsciiDigit(code: number): boolean {
  return code >= CHAR_ZERO && code <= CHAR_NINE
}

/**
 * Parse one cell the way pandas' C parser does.
 *
 * Returns `null` when pandas would *not* accept the text as a float — which is
 * how a column ends up as `object` dtype and how `pd.to_numeric(errors='coerce')`
 * decides to emit a missing value. `Infinity` is never returned from here; the
 * infinity spellings are handled by the caller, mirroring pandas, where they are
 * a fallback applied after the numeric conversion has failed.
 *
 * Known faithful quirks, reproduced deliberately:
 *   - only the first 17 significant digits are read, the rest shift the decimal
 *     exponent, so `0.00000000000000000001` converts to `0` exactly as pandas
 *     does with its default `float_precision`;
 *   - a decimal exponent above 308, or a scaled value that overflows to
 *     infinity, is reported as *not a number* rather than as `Infinity`,
 *     because the tokenizer sets `ERANGE` and the caller then rejects the cell.
 *
 * Deliberate, documented divergence: an all-integer column is `int64` in pandas
 * and converts to float in one correctly-rounded step, whereas this converter
 * accumulates digit by digit. The two agree for every integer below 2^53, which
 * covers any physically meaningful sample; they can differ only for integer
 * literals of 16+ digits.
 */
export function parsePandasFloat(text: string): number | null {
  const length = text.length
  let position = 0

  while (position < length && isAsciiSpace(text.charCodeAt(position))) position++

  let negative = false
  const signCode = position < length ? text.charCodeAt(position) : 0
  if (signCode === CHAR_MINUS) {
    negative = true
    position++
  } else if (signCode === CHAR_PLUS) {
    position++
  }

  let number = 0
  let exponent = 0
  let digits = 0
  let decimals = 0

  while (position < length && isAsciiDigit(text.charCodeAt(position))) {
    if (digits < MAX_DIGITS) {
      number = number * 10 + (text.charCodeAt(position) - CHAR_ZERO)
      digits++
    } else {
      // Digits past the significand only move the decimal point.
      exponent++
    }
    position++
  }

  if (position < length && text.charCodeAt(position) === CHAR_DOT) {
    position++
    while (position < length && digits < MAX_DIGITS && isAsciiDigit(text.charCodeAt(position))) {
      number = number * 10 + (text.charCodeAt(position) - CHAR_ZERO)
      position++
      digits++
      decimals++
    }
    if (digits >= MAX_DIGITS) {
      while (position < length && isAsciiDigit(text.charCodeAt(position))) position++
    }
    exponent -= decimals
  }

  if (digits === 0) return null

  if (negative) number = -number

  const exponentMarker = position < length ? text.charCodeAt(position) : 0
  if (exponentMarker === CHAR_LOWER_E || exponentMarker === CHAR_UPPER_E) {
    const markerPosition = position
    position++
    let negativeExponent = false
    const exponentSign = position < length ? text.charCodeAt(position) : 0
    if (exponentSign === CHAR_MINUS) {
      negativeExponent = true
      position++
    } else if (exponentSign === CHAR_PLUS) {
      position++
    }
    let exponentDigits = 0
    let exponentValue = 0
    while (position < length && isAsciiDigit(text.charCodeAt(position))) {
      exponentValue = exponentValue * 10 + (text.charCodeAt(position) - CHAR_ZERO)
      exponentDigits++
      position++
    }
    exponent += negativeExponent ? -exponentValue : exponentValue
    // "1e" with no digits: the tokenizer un-consumes the marker, which leaves
    // trailing text behind and makes the whole cell non-numeric.
    if (exponentDigits === 0) position = markerPosition
  }

  // `skip_trailing = 1`: trailing whitespace is allowed, anything else is not.
  while (position < length && isAsciiSpace(text.charCodeAt(position))) position++
  if (position !== length) return null

  if (exponent > 308) return null
  if (exponent > 0) {
    number *= POWERS_OF_TEN[exponent] as number
  } else if (exponent < -308) {
    // Subnormal range: the tokenizer scales in two steps to stay in range.
    if (exponent < -616) {
      number = 0
    } else {
      number /= POWERS_OF_TEN[-308 - exponent] as number
      number /= POWERS_OF_TEN[308] as number
    }
  } else {
    number /= POWERS_OF_TEN[-exponent] as number
  }

  // The tokenizer flags an overflowed result as ERANGE, and the caller then
  // treats the cell as non-numeric rather than as an infinity.
  if (!Number.isFinite(number)) return null

  return number
}

/**
 * pandas' default `na_values` — cells read as missing before any conversion.
 *
 * Taken from `pandas._libs.parsers.STR_NA_VALUES`. The empty string is included,
 * which is how a blank cell becomes NaN while keeping the column numeric.
 */
export const PANDAS_NA_VALUES: ReadonlySet<string> = new Set([
  '',
  '#N/A',
  '#N/A N/A',
  '#NA',
  '-1.#IND',
  '-1.#QNAN',
  '-NaN',
  '-nan',
  '1.#IND',
  '1.#QNAN',
  '<NA>',
  'N/A',
  'NA',
  'NULL',
  'NaN',
  'None',
  'n/a',
  'nan',
  'null',
])

/** True when pandas would read the raw cell text as a missing value. */
export function isMissingToken(text: string): boolean {
  return PANDAS_NA_VALUES.has(text)
}

/**
 * The infinity spellings the C parser accepts, matched case-insensitively after
 * the numeric conversion has failed (`cinf` / `cposinf` / `cneginf` and the
 * `Infinity` forms in `pandas/_libs/parsers.pyx`).
 */
function parseInfinityToken(text: string): number | null {
  // `strcasecmp` against the whole cell — no trimming, exactly as pandas does it.
  const normalised = text.toLowerCase()
  if (normalised === 'inf' || normalised === '+inf') return Number.POSITIVE_INFINITY
  if (normalised === 'infinity' || normalised === '+infinity') return Number.POSITIVE_INFINITY
  if (normalised === '-inf' || normalised === '-infinity') return Number.NEGATIVE_INFINITY
  return null
}

/** How pandas classified one raw cell. */
export type CellKind =
  /** A finite number, or one of the accepted infinities. */
  | 'number'
  /** Recognised as missing before conversion (blank cell, `NA`, `null`, ...). */
  | 'missing'
  /** Text pandas cannot read as a number; `to_numeric(errors='coerce')` drops it. */
  | 'invalid'

export interface ParsedCell {
  kind: CellKind
  /** NaN for `missing` and `invalid`, the parsed double for `number`. */
  value: number
}

const MISSING_CELL: ParsedCell = { kind: 'missing', value: Number.NaN }
const INVALID_CELL: ParsedCell = { kind: 'invalid', value: Number.NaN }

/**
 * Classify and convert a raw cell, reproducing `read_csv` followed by
 * `pd.to_numeric(errors='coerce')`.
 */
export function parseCell(text: string): ParsedCell {
  if (isMissingToken(text)) return MISSING_CELL
  const numeric = parsePandasFloat(text)
  if (numeric !== null) return { kind: 'number', value: numeric }
  const infinity = parseInfinityToken(text)
  if (infinity !== null) return { kind: 'number', value: infinity }
  return INVALID_CELL
}
