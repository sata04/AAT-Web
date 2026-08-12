/**
 * Unit coverage for the reading half of the pipeline: byte decoding, pandas'
 * float conversion, CSV tokenising and column detection.
 *
 * The golden fixtures pin the paths a real measurement takes. These tests pin
 * the branches a real measurement does *not* take but a broken file will —
 * fallbacks, malformed input, and the two places where reproducing pandas
 * exactly is subtle enough to be worth an explicit example.
 */

import { describe, expect, it } from 'vitest'
import { detectColumns } from '../src/columns.ts'
import { isNumericColumn, parseCsvText, toNumericColumn } from '../src/csv.ts'
import { decodeCsv } from '../src/decode.ts'
import { type AnalysisError, CsvDecodeError, CsvParseError, DataProcessingError } from '../src/errors.ts'
import { isMissingToken, parseCell, parsePandasFloat } from '../src/pandas-number.ts'
import { loadFixtureBytes } from './golden.ts'

const encoder = new TextEncoder()

describe('decodeCsv', () => {
  it('reads UTF-8 and reports it', () => {
    const decoded = decodeCsv(encoder.encode('時間,加速度\n0.0,1.0\n'))
    expect(decoded.encoding).toBe('utf-8')
    expect(decoded.text.startsWith('時間')).toBe(true)
  })

  it('strips a UTF-8 byte order mark so it cannot become part of a column name', () => {
    const decoded = decodeCsv(encoder.encode('﻿Time (s),Accel\n0.0,1.0\n'))
    expect(decoded.text.startsWith('Time (s)')).toBe(true)
    expect(parseCsvText(decoded.text).columnNames[0]).toBe('Time (s)')
  })

  it('falls back to Shift_JIS for a Windows-31J file', () => {
    const decoded = decodeCsv(loadFixtureBytes('csv/japanese_headers_cp932.csv'))
    expect(decoded.encoding).toBe('shift_jis')
    expect(decoded.text.startsWith('データセット1:時間(s)')).toBe(true)
  })

  it('refuses bytes that are valid in neither encoding rather than emitting U+FFFD', () => {
    expect(() => decodeCsv(new Uint8Array([0x80, 0xff]))).toThrow(CsvDecodeError)
    try {
      decodeCsv(new Uint8Array([0x80, 0xff]))
    } catch (error) {
      expect((error as AnalysisError).code).toBe('CSV_DECODE_FAILED')
    }
  })
})

describe('parsePandasFloat', () => {
  it('reproduces pandas rather than the correctly-rounded parser', () => {
    // The whole reason this module exists: read_csv's default converter lands
    // one ulp away from float()/Number() on 16-significant-digit input.
    expect(parsePandasFloat('-9.601626439999999')).toBe(-9.60162644)
    expect(parsePandasFloat('-9.601626439999999')).not.toBe(Number('-9.601626439999999'))
  })

  it('keeps only 17 significant digits, as the tokenizer does', () => {
    // Faithful quirk: pandas' default float_precision loses this value entirely.
    expect(parsePandasFloat('0.00000000000000000001')).toBe(0)
    expect(Number('0.00000000000000000001')).toBe(1e-20)
  })

  it('accepts signs, exponents and surrounding whitespace', () => {
    expect(parsePandasFloat('+3.25')).toBe(3.25)
    expect(parsePandasFloat('  -2.5\t')).toBe(-2.5)
    expect(parsePandasFloat('1.5e3')).toBe(1500)
    expect(parsePandasFloat('15E-1')).toBe(1.5)
  })

  it('rejects what pandas rejects', () => {
    expect(parsePandasFloat('')).toBeNull()
    expect(parsePandasFloat('ERR')).toBeNull()
    expect(parsePandasFloat('1.5x')).toBeNull()
    // An exponent marker with no digits leaves trailing text behind.
    expect(parsePandasFloat('1e')).toBeNull()
    // Overflow is ERANGE in the tokenizer, which makes the cell non-numeric.
    expect(parsePandasFloat('1e400')).toBeNull()
  })
})

describe('parseCell', () => {
  it('separates missing values from unreadable text', () => {
    expect(parseCell('').kind).toBe('missing')
    expect(parseCell('n/a').kind).toBe('missing')
    expect(parseCell('NULL').kind).toBe('missing')
    expect(parseCell('ERR').kind).toBe('invalid')
    expect(parseCell('---').kind).toBe('invalid')
    expect(isMissingToken('NaN')).toBe(true)
  })

  it('reads the infinity spellings the C parser accepts', () => {
    expect(parseCell('inf')).toEqual({ kind: 'number', value: Number.POSITIVE_INFINITY })
    expect(parseCell('-inf')).toEqual({ kind: 'number', value: Number.NEGATIVE_INFINITY })
    expect(parseCell('Infinity').value).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('parseCsvText', () => {
  it('keeps quoted fields containing the delimiter, across CRLF lines', () => {
    const table = parseCsvText('"Time, (s)","Accel 1, inner"\r\n0.0,1.0\r\n0.001,2.0\r\n')
    expect(table.columnNames).toEqual(['Time, (s)', 'Accel 1, inner'])
    expect(table.rowCount).toBe(2)
    expect(table.column('Accel 1, inner')?.cells).toEqual(['1.0', '2.0'])
  })

  it('auto-detects the delimiter', () => {
    // A deliberate improvement on the desktop app, which is hard-wired to ','
    // and reads a semicolon file as a single column.
    const table = parseCsvText('Time;Accel\n0.0;1.0\n')
    expect(table.columnNames).toEqual(['Time', 'Accel'])
  })

  it('mangles duplicate headers the way pandas does', () => {
    const table = parseCsvText('a,a,a\n1,2,3\n')
    expect(table.columnNames).toEqual(['a', 'a.1', 'a.2'])
    expect(table.column('a.2')?.cells).toEqual(['3'])
  })

  it('skips blank lines and pads short rows', () => {
    const table = parseCsvText('t,a,b\n\n0.0,1.0,2.0\n0.001,3.0\n')
    expect(table.rowCount).toBe(2)
    expect(table.column('b')?.cells).toEqual(['2.0', ''])
  })

  it('refuses a row with more fields than the header instead of shifting columns', () => {
    expect(() => parseCsvText('t,a\n0.0,1.0,9.0\n')).toThrow(CsvParseError)
  })

  it('refuses an empty file', () => {
    expect(() => parseCsvText('')).toThrow(/no header row/)
  })
})

describe('toNumericColumn', () => {
  it('counts missing and coerced cells separately', () => {
    const table = parseCsvText('a,b\n1.0,w\n,x\nERR,y\n2.0,z\n')
    const result = toNumericColumn(table.column('a') as never)
    expect(Array.from(result.values.map((value) => (Number.isNaN(value) ? -1 : value)))).toEqual([
      1, -1, -1, 2,
    ])
    expect(result.missingCount).toBe(1)
    expect(result.coercedCount).toBe(1)
  })

  it('rejects a column with no numeric value at all', () => {
    const table = parseCsvText('a\nERR\nn/a\n')
    expect(() => toNumericColumn(table.column('a') as never)).toThrow(DataProcessingError)
  })

  it('accepts a column that is empty because the file has no rows', () => {
    const table = parseCsvText('a,b\n')
    expect(toNumericColumn(table.column('a') as never).values.length).toBe(0)
  })
})

describe('isNumericColumn', () => {
  it('mirrors pandas dtype inference', () => {
    const table = parseCsvText('numbers,gapped,text,flags\n1.0,1.0,ok,True\n2.0,,ERR,False\n')
    expect(isNumericColumn(table.column('numbers') as never)).toBe(true)
    // A blank cell still leaves the column float64.
    expect(isNumericColumn(table.column('gapped') as never)).toBe(true)
    expect(isNumericColumn(table.column('text') as never)).toBe(false)
    // `is_numeric_dtype` is True for bool columns.
    expect(isNumericColumn(table.column('flags') as never)).toBe(true)
  })
})

describe('detectColumns', () => {
  it('applies Python’s Unicode word boundaries, not JavaScript’s', () => {
    // U+00B2 is alphanumeric to Python, so `\bs\b` does not match "m/s²" and the
    // acceleration columns are not offered as time candidates. A plain
    // JavaScript `\b` would see a boundary there and classify them as time.
    const superscript = parseCsvText(
      'データセット1:時間(s),データセット1:Z-axis acceleration 1(m/s²)\n0.0,1.0\n',
    )
    expect(detectColumns(superscript).time).toEqual(['データセット1:時間(s)'])

    // Spelled out as "^2", the same header *is* a time candidate — which is what
    // the cp932 fixture records.
    const caret = parseCsvText('データセット1:時間(s),データセット1:Z軸加速度 1(m/s^2)\n0.0,1.0\n')
    expect(detectColumns(caret).time).toEqual(['データセット1:時間(s)', 'データセット1:Z軸加速度 1(m/s^2)'])
  })

  it('falls back to numeric columns when no header matches', () => {
    const table = parseCsvText('X1,X2,X3\n0.0,1.0,2.0\n0.001,1.5,2.5\n')
    // Every numeric column is a possible time axis; the acceleration fallback
    // drops the first one on the assumption that it is the time axis.
    expect(detectColumns(table)).toEqual({ time: ['X1', 'X2', 'X3'], acceleration: ['X2', 'X3'] })
  })

  it('excludes only name-matched time columns from the acceleration fallback', () => {
    const table = parseCsvText('t,v1,v2\n0.0,1.0,2.0\n0.001,1.5,2.5\n')
    expect(detectColumns(table)).toEqual({ time: ['t'], acceleration: ['v2'] })
  })

  it('offers every numeric column when the only name match is a time column', () => {
    const table = parseCsvText('Time (s),label\n0.0,ok\n0.001,ok\n')
    expect(detectColumns(table)).toEqual({ time: ['Time (s)'], acceleration: [] })
  })
})
