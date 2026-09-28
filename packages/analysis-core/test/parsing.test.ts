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
import { DEFAULT_ANALYSIS_CONFIG } from '../src/config.ts'
import { isNumericColumn, parseCsvText, toNumericColumn } from '../src/csv.ts'
import { decodeCsv } from '../src/decode.ts'
import { type AnalysisError, CsvDecodeError, CsvParseError, DataProcessingError } from '../src/errors.ts'
import { isMissingToken, parseCell, parsePandasFloat } from '../src/pandas-number.ts'
import { loadAndProcessData } from '../src/pipeline.ts'
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
  })

  it('lets magnitudes overflow to a signed infinity, as the tokenizer does', () => {
    // `exponent > 308` in tokenizer.c produces -HUGE_VAL / HUGE_VAL, which the
    // caller accepts — overflow is not ERANGE.
    expect(parsePandasFloat('1e400')).toBe(Number.POSITIVE_INFINITY)
    expect(parsePandasFloat('-1e400')).toBe(Number.NEGATIVE_INFINITY)
    // A signed zero stays zero even with a huge exponent.
    expect(parsePandasFloat('0e999')).toBe(0)
    // A large mantissa can also overflow at the scale step (1e17 * 1e308).
    expect(parsePandasFloat('99999999999999999999e300')).toBe(Number.POSITIVE_INFINITY)
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

  it.each([';', '\t', '|'])('still reads genuine %j-delimited tables', (delimiter) => {
    const table = parseCsvText(`t${delimiter}a\n0${delimiter}1\n1${delimiter}2\n`)
    expect(table.columnNames).toEqual(['t', 'a'])
    expect(table.column('a')?.cells).toEqual(['1', '2'])
  })

  it.each([';', '\t', '|'])('sniffs %j without discarding quoted-empty records', (delimiter) => {
    const table = parseCsvText(`t${delimiter}a\n0${delimiter}1\n""\n2${delimiter}1\n`)
    expect(table.columnNames).toEqual(['t', 'a'])
    expect(table.column('t')?.cells).toEqual(['0', '', '2'])
    expect(Array.from(toNumericColumn(table.column('a') as never).values)).toEqual([1, Number.NaN, 1])
  })

  it.each([';', '\t', '|'])(
    'uses the %j header when short records defeat delimiter averages',
    (delimiter) => {
      const table = parseCsvText(`t${delimiter}a\n0${delimiter}1\n\f\n\v\n\u00a0\n2${delimiter}1\n`)
      expect(table.columnNames).toEqual(['t', 'a'])
      expect(table.column('a')?.cells).toEqual(['1', '', '', '', '1'])
    },
  )

  it.each([';', '\t', '|'])('tracks quotes using only the selected %j delimiter', (delimiter) => {
    const other = delimiter === '|' ? ';' : '|'
    const table = parseCsvText(
      `t${delimiter}a${delimiter}n\r\n0${delimiter}1${delimiter}x${other}"q\r1${delimiter}2${delimiter}end\n`,
    )
    expect(table.column('a')?.cells).toEqual(['1', '2'])
    expect(table.column('n')?.cells).toEqual([`x${other}"q`, 'end'])
    const quoted = parseCsvText(
      `t${delimiter}a${delimiter}n\r\n0${delimiter}1${delimiter}" ;,|\t "\r""\n1${delimiter}2${delimiter}end\n`,
    )
    expect(quoted.column('n')?.cells).toEqual([' ;,|\t ', '', 'end'])
  })

  it('prefers comma when metadata also forms a consistent pipe table', () => {
    const table = parseCsvText('t,a,n|o|t|e\n0,1,p|q|r|s\n1,1,p|q|r|s\n')
    expect(table.columnNames).toEqual(['t', 'a', 'n|o|t|e'])
    expect(table.column('a')?.cells).toEqual(['1', '1'])
  })

  it.each(['\t', ';', '|'])(
    'recognises %j tables with commas inside quoted headers and cells',
    (delimiter) => {
      // Verified with pandas 3.0.5 read_csv(..., sep=delimiter); the desktop's
      // comma default does not autodetect alternative delimiters.
      const table = parseCsvText(
        `t${delimiter}a${delimiter}"note,unit"\n0${delimiter}1${delimiter}"a,b"\n1${delimiter}2${delimiter}"c,d"\n`,
      )
      expect(table.columnNames).toEqual(['t', 'a', 'note,unit'])
      expect(table.column('a')?.cells).toEqual(['1', '2'])
      expect(table.column('note,unit')?.cells).toEqual(['a,b', 'c,d'])
    },
  )

  it.each(['\t', ';', '|'])('recognises %j when only the header contains a comma', (delimiter) => {
    const table = parseCsvText(
      `t${delimiter}a${delimiter}note,unit\n0${delimiter}1${delimiter}plain\n1${delimiter}2${delimiter}text\n`,
    )
    expect(table.columnNames).toEqual(['t', 'a', 'note,unit'])
    expect(table.column('a')?.cells).toEqual(['1', '2'])
    expect(table.column('note,unit')?.cells).toEqual(['plain', 'text'])
  })

  it.each([
    ['quotes', 't,a,n|o|t|e\n0,1,"p|q|r|s\n1,2,p|q|r|s\n'],
    ['width after an implicit index', 't,a,n|o|t|e\nr0,0,1,p|q|r|s\nr1,1,2,3,p|q|r|s\n'],
    ['width without an index', 't,a,n|o|t|e\n0,1,p|q|r|s\n1,2,3,p|q|r|s\n'],
  ])('does not reinterpret pipes to hide comma %s errors', (_kind, text) => {
    expect(() => parseCsvText(text as string)).toThrow(CsvParseError)
    expect(() => parseCsvText(text as string)).toThrowError(
      expect.objectContaining({ code: 'CSV_PARSE_FAILED' }),
    )
  })

  it('mangles duplicate headers the way pandas does', () => {
    const table = parseCsvText('a,a,a\n1,2,3\n')
    expect(table.columnNames).toEqual(['a', 'a.1', 'a.2'])
    expect(table.column('a.2')?.cells).toEqual(['3'])
  })

  it('skips a candidate that collides with a literal header, like pandas', () => {
    // pandas' header pass (`python_parser._infer_columns`) checks each generated
    // candidate against the whole header row, so the literal `a.1` at index 1
    // takes the first candidate and the repeat becomes a.2, not a.1.1.
    const table = parseCsvText('a,a.1,a\n1,2,3\n')
    expect(table.columnNames).toEqual(['a', 'a.1', 'a.2'])
    expect(table.column('a.1')?.cells).toEqual(['2'])
    expect(table.column('a.2')?.cells).toEqual(['3'])
  })

  it('reserves literal header names ahead of the duplicate being renamed', () => {
    // `a.1` exists later in the row, so the second `a` skips straight to a.2.
    expect(parseCsvText('a,a,a.1\n1,2,3\n').columnNames).toEqual(['a', 'a.2', 'a.1'])
    // …but a name only produced by an earlier rename does not reserve itself:
    // the second `a.1` becomes a.1.1 and the second `a` then skips a.1 → a.2.
    expect(parseCsvText('a,a.1,a.1,a\n1,2,3,4\n').columnNames).toEqual(['a', 'a.1', 'a.1.1', 'a.2'])
    expect(parseCsvText('x,x.1,x,x.1\n1,2,3,4\n').columnNames).toEqual(['x', 'x.1', 'x.2', 'x.1.1'])
  })

  it('names blank header cells Unnamed: {position}, like pandas', () => {
    expect(parseCsvText('a,,b\n1,2,3\n').columnNames).toEqual(['a', 'Unnamed: 1', 'b'])
    expect(parseCsvText(',a,\n1,2,3\n').columnNames).toEqual(['Unnamed: 0', 'a', 'Unnamed: 2'])
    // A literal Unnamed name wins: the blank cell is mangled, not the literal.
    expect(parseCsvText('Unnamed: 1,\n1,2\n').columnNames).toEqual(['Unnamed: 1', 'Unnamed: 1.1'])
  })

  it('skips blank lines and pads short rows', () => {
    const table = parseCsvText('t,a,b\n\n0.0,1.0,2.0\n0.001,3.0\n')
    expect(table.rowCount).toBe(2)
    expect(table.column('b')?.cells).toEqual(['2.0', ''])
  })

  it('preserves a quoted empty record as a missing sample', () => {
    const table = parseCsvText('t,a\n0,1\n""\n2,1\n')
    expect(table.rowCount).toBe(3)
    expect(table.column('t')?.cells).toEqual(['0', '', '2'])
    expect(Array.from(toNumericColumn(table.column('a') as never).values)).toEqual([1, Number.NaN, 1])
  })

  it('skips whitespace-only physical lines before the header and within the body', () => {
    const table = parseCsvText(' \t\r\n\t\nt,a\n0,1\n  \t  \n1,1\n   ')
    expect(table.columnNames).toEqual(['t', 'a'])
    expect(table.rowCount).toBe(2)
    expect(table.column('t')?.cells).toEqual(['0', '1'])
  })

  describe.each([',', ';', '\t', '|'])('pandas blank records with delimiter %j', (delimiter) => {
    it.each(['', '   ', '\t', ' \t ', '\t \t'])('skips %j only if it creates no fields', (record) => {
      const table = parseCsvText(`t${delimiter}a${delimiter}n\n0${delimiter}1\n${record}\n2${delimiter}1\n`)
      const kept = delimiter === '\t' && record.includes('\t')
      expect(table.rowCount).toBe(kept ? 3 : 2)
      expect(table.column('t')?.cells).toEqual(kept ? ['0', record.split('\t')[0], '2'] : ['0', '2'])
    })

    it.each(['\f', '\v', '\u00a0', '\u2028', '\u2029', '\u0085', '\u2003', ' \f ', '\u00a0 '])(
      'preserves the nonblank record %j',
      (record) => {
        const table = parseCsvText(`t${delimiter}a\n0${delimiter}1\n${record}\n2${delimiter}1\n`)
        expect(table.column('t')?.cells).toEqual(['0', record, '2'])
        expect(Array.from(toNumericColumn(table.column('a') as never).values)).toEqual([1, Number.NaN, 1])
      },
    )

    it.each(['""', '" "', 'delimiter', 'two delimiters', 'spaced delimiter'])(
      'preserves fields created by %s',
      (kind) => {
        const record =
          kind === 'delimiter'
            ? delimiter
            : kind === 'two delimiters'
              ? delimiter.repeat(2)
              : kind === 'spaced delimiter'
                ? ` ${delimiter} `
                : kind
        const table = parseCsvText(`t${delimiter}a${delimiter}n\n0${delimiter}1\n${record}\n2${delimiter}1\n`)
        expect(table.rowCount).toBe(3)
        expect(table.column('t')?.cells[1]).toBe(kind === '" "' || kind === 'spaced delimiter' ? ' ' : '')
      },
    )
  })

  it('normalises mixed CRLF, LF and CR record separators', () => {
    const table = parseCsvText('t,a\r\n0,1\r\n1,1\n2,1\r3,1\r\n')
    expect(table.rowCount).toBe(4)
    expect(table.column('t')?.cells).toEqual(['0', '1', '2', '3'])
  })

  it('preserves quoted newlines, whitespace lines and escaped quotes inside cells', () => {
    const table = parseCsvText('t,a,note\r\n0,1,"first\r\n \t\nlast ""line""\rend"\n1,2,ok\r')
    expect(table.rowCount).toBe(2)
    expect(table.column('note')?.cells).toEqual(['first\r\n \t\nlast "line"\rend', 'ok'])
    expect(table.column('a')?.cells).toEqual(['1', '2'])
  })

  it('keeps literal quotes in unquoted fields from swallowing later records', () => {
    const table = parseCsvText('t,a,note\n0,1,a|"b\r1,2,ok\n')
    expect(table.rowCount).toBe(2)
    expect(table.column('note')?.cells).toEqual(['a|"b', 'ok'])
  })

  it('accepts a consistent leading implicit index, matching pandas', () => {
    // read_csv infers an index from the first body row.
    const table = parseCsvText('t,a\nrow0,0,1\nrow1,1,1\n')
    expect(table.columnNames).toEqual(['t', 'a'])
    expect(table.column('t')?.cells).toEqual(['0', '1'])
    expect(table.column('a')?.cells).toEqual(['1', '1'])
  })

  it('keeps comma columns when an indexed table contains a quoted-empty record', () => {
    const table = parseCsvText('t,a,n|o|t|e\nr0,0,1,p|q|r|s\nr1,1,2,p|q|r|s\n""\n')
    expect(table.columnNames).toEqual(['t', 'a', 'n|o|t|e'])
    expect(table.column('t')?.cells).toEqual(['0', '1', ''])
    expect(table.column('a')?.cells).toEqual(['1', '2', ''])
  })

  it.each([',', ';', '\t', '|'])(
    'pads short rows after inferring a %j index from the first row',
    (delimiter) => {
      const table = parseCsvText(
        ['t,a,n', 'r0,0,1,note', 'r1,1,2', '2,3', '4', '""'].join('\n').replaceAll(',', delimiter),
      )
      expect(table.column('t')?.cells).toEqual(['0', '1', '3', '', ''])
      expect(table.column('a')?.cells).toEqual(['1', '2', '', '', ''])
      expect(table.column('n')?.cells).toEqual(['note', '', '', '', ''])
      const short = parseCsvText(['t,a,n', 'r1,1,2', 'r2,2'].join('\n').replaceAll(',', delimiter))
      expect(short.column('t')?.cells).toEqual(['r1', 'r2'])
      expect(short.column('a')?.cells).toEqual(['1', '2'])
      expect(short.column('n')?.cells).toEqual(['2', ''])
      expect(() =>
        parseCsvText(['t,a,n', '""', 'r0,0,1,note'].join('\n').replaceAll(',', delimiter)),
      ).toThrow(CsvParseError)
    },
  )

  it.each(['t,a\n0,1\nrow1,1,1\n', 't,a\ni,j,0,1\n'])(
    'refuses inconsistent or unsupported excess fields in %j',
    (text) => {
      expect(() => parseCsvText(text)).toThrow(CsvParseError)
    },
  )

  it('truncates cells at NUL without dropping fields or samples', () => {
    const table = parseCsvText('t,a,note\n0,2\0junk,first\n1,2,last\n')
    expect(table.rowCount).toBe(2)
    expect(table.column('note')?.cells).toEqual(['first', 'last'])
    const column = table.column('a') as never
    expect(isNumericColumn(column)).toBe(true)
    expect(toNumericColumn(column)).toEqual({
      values: Float64Array.of(2, 2),
      missingCount: 0,
      coercedCount: 0,
    })
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

  it('reads an all-boolean column as 1.0/0.0, matching pandas bool dtype', () => {
    const table = parseCsvText('flags\nTrue\nFalse\ntrue\n')
    const result = toNumericColumn(table.column('flags') as never)
    expect(Array.from(result.values)).toEqual([1, 0, 1])
    expect(result.missingCount).toBe(0)
    expect(result.coercedCount).toBe(0)
  })

  it.each(['NA', '', 'null'])('converts boolean values with a %j gap from pandas object dtype', (missing) => {
    const table = parseCsvText(`t,a\n0,True\n1,${missing}\n2,False\n`)
    const column = table.column('a') as never
    expect(isNumericColumn(column)).toBe(false)
    expect(toNumericColumn(column)).toEqual({
      values: Float64Array.of(1, Number.NaN, 0),
      missingCount: 1,
      coercedCount: 0,
    })
  })

  it('still coerces boolean strings in mixed numeric columns and rejects boolean/text columns', () => {
    expect(toNumericColumn({ name: 'a', cells: ['True', '1', 'False'] })).toEqual({
      values: Float64Array.of(Number.NaN, 1, Number.NaN),
      missingCount: 0,
      coercedCount: 2,
    })
    expect(() => toNumericColumn({ name: 'a', cells: ['True', 'ERR', 'False'] })).toThrow(DataProcessingError)
  })

  it('converts zero-padded integer columns exactly before casting to float64', () => {
    const table = parseCsvText('t,a\n0,0000000000000000001\n1,1\n')
    expect(Array.from(toNumericColumn(table.column('a') as never).values)).toEqual([1, 1])
  })

  it('normalises signed integer zero, including columns with NA', () => {
    const result = toNumericColumn({ name: 'a', cells: ['-0', '+0', 'NA', '000000000000000001'] })
    expect(Array.from(result.values)).toEqual([0, 0, Number.NaN, 1])
    expect(Object.is(result.values[0], 0)).toBe(true)
    expect(result.missingCount).toBe(1)
    expect(result.coercedCount).toBe(0)
  })

  it('casts both int64 boundaries in one rounding step', () => {
    const result = toNumericColumn({ name: 'a', cells: ['9223372036854775807', '-9223372036854775808'] })
    expect(Array.from(result.values)).toEqual([9223372036854776000, -9223372036854776000])
  })

  it.each([
    ['9223372036854775808', 0x43e0000000000000n],
    ['9223372036854775809', 0x43e0000000000000n],
    ['18446744073709551615', 0x43f0000000000000n],
  ] as const)('casts uint64 %s exactly before converting to float64', (integer, bits) => {
    const column = { name: 'a', cells: [integer, '1'] }
    const values = toNumericColumn(column).values
    const encoded = new DataView(new ArrayBuffer(8))
    encoded.setFloat64(0, values[0] as number)
    expect(encoded.getBigUint64(0)).toBe(bits)
    expect(values[1]).toBe(1)
    expect(isNumericColumn(column)).toBe(true)
  })

  it('uses int64-min as an NA sentinel only when missing cells require a float cast', () => {
    const minimum = '-9223372036854775808'
    expect(Array.from(toNumericColumn({ name: 'a', cells: [minimum] }).values)).toEqual([
      -9223372036854776000,
    ])
    expect(toNumericColumn({ name: 'a', cells: [minimum, '1', 'NA'] })).toEqual({
      values: Float64Array.of(Number.NaN, 1, Number.NaN),
      missingCount: 2,
      coercedCount: 0,
    })
    expect(() => toNumericColumn({ name: 'a', cells: [minimum, 'NA'] })).toThrow(DataProcessingError)
    expect(
      Array.from(toNumericColumn({ name: 'a', cells: ['-9223372036854775807', '1', 'NA'] }).values),
    ).toEqual([-9223372036854776000, 1, Number.NaN])
    expect(Array.from(toNumericColumn({ name: 'a', cells: [minimum, '1.0'] }).values)).toEqual([
      -9223372036854778000, 1,
    ])
  })

  it.each([
    ['-9223372036854775809', -9223372036854776000],
    ['18446744073709551616', 18446744073709552000],
    ['18446744073709551617', 18446744073709552000],
  ] as const)('casts pandas 3 integer objects outside the 64-bit bounds: %s', (integer, expected) => {
    const column = { name: 'a', cells: [integer, '1', 'NA'] }
    expect(Array.from(toNumericColumn(column).values)).toEqual([expected, 1, Number.NaN])
    expect(isNumericColumn(column)).toBe(false)
  })

  it.each(['NA', '-1'])('keeps uint64 mixed with %s on string-to-float conversion', (tail) => {
    const column = { name: 'a', cells: ['9223372036854775808', '1', tail] }
    expect(Array.from(toNumericColumn(column).values)).toEqual([
      9223372036854778000,
      1,
      tail === 'NA' ? Number.NaN : -1,
    ])
    expect(isNumericColumn(column)).toBe(false)
  })

  it('distinguishes unsigned dtype detection from subsequent conversion of negative zero', () => {
    const column = { name: 'a', cells: ['9223372036854775808', '-0'] }
    expect(isNumericColumn(column)).toBe(false)
    expect(Array.from(toNumericColumn(column).values)).toEqual([9223372036854776000, 0])
    expect(isNumericColumn({ ...column, cells: ['9223372036854775808', '+0'] })).toBe(true)
  })

  it('keeps out-of-int64 mixed-sign columns on pandas object-to-float conversion', () => {
    const result = toNumericColumn({ name: 'a', cells: ['9223372036854775808', '-1'] })
    expect(Array.from(result.values)).toEqual([9223372036854778000, -1])
  })

  it.each([false, true])(
    'uses decimal conversion for signed underflow with uint64 (reversed: %s)',
    (reversed) => {
      // pandas 3.0.5 infers strings, so _to_numeric_series uses the decimal
      // converter, one ULP away from converting Python integer objects.
      const cells = ['-9223372036854775809', '9223372036854775808']
      const expected = [-9.223372036854778e18, 9.223372036854778e18]
      if (reversed) {
        cells.reverse()
        expected.reverse()
      }
      const table = parseCsvText(`t,a\n0,${cells[0]}\n1,${cells[1]}\n`)
      const column = table.column('a') as never
      expect(isNumericColumn(column)).toBe(false)
      expect(toNumericColumn(column)).toEqual({
        values: Float64Array.from(expected),
        missingCount: 0,
        coercedCount: 0,
      })
    },
  )

  it.each([
    { cells: ['9223372036854775808', 'NA'], coercedCount: 1 },
    { cells: ['9223372036854775808', '-1', 'NA'], coercedCount: 1 },
    { cells: ['-9223372036854775809', '9223372036854775808', 'NA'], coercedCount: 1 },
    { cells: ['18446744073709551616', '1.5', 'NA'], coercedCount: 1 },
    { cells: ['18446744073709551616', 'ERR', 'NA'], coercedCount: 2 },
  ])(
    'counts literal NA as coercion when integer inference preserves strings: $cells',
    ({ cells, coercedCount }) => {
      const table = parseCsvText(`t,a\n${cells.map((cell, index) => `${index},${cell}`).join('\n')}\n`)
      const result = toNumericColumn(table.column('a') as never)
      expect(result.missingCount).toBe(0)
      expect(result.coercedCount).toBe(coercedCount)
      expect(result.values[result.values.length - 1]).toBeNaN()
      const loaded = loadAndProcessData(table, {
        ...DEFAULT_ANALYSIS_CONFIG,
        timeColumn: 't',
        accelerationColumnInnerCapsule: 'a',
        useDragAcceleration: false,
      })
      expect(loaded.warnings).toContainEqual(
        expect.objectContaining({ code: 'CELLS_COERCED', details: { column: 'a', count: coercedCount } }),
      )
    },
  )

  it.each(['', 'null', 'NaN'])('also coerces the literal NA spelling %j in uint64 conflicts', (missing) => {
    expect(toNumericColumn({ name: 'a', cells: ['9223372036854775808', missing] })).toEqual({
      values: Float64Array.of(9.223372036854778e18, Number.NaN),
      missingCount: 0,
      coercedCount: 1,
    })
  })

  it.each([
    { cells: ['ERR', '18446744073709551616', 'NA'], coercedCount: 1 },
    { cells: ['1.5', '18446744073709551616', 'NA'], coercedCount: 0 },
    { cells: ['9223372036854775808', 'ERR', 'NA'], coercedCount: 1 },
    { cells: ['-9223372036854775809', '1.5', 'NA'], coercedCount: 0 },
  ])('still counts actual missing values when inference normalises NA: $cells', ({ cells, coercedCount }) => {
    const result = toNumericColumn({ name: 'a', cells })
    expect(result.missingCount).toBe(1)
    expect(result.coercedCount).toBe(coercedCount)
  })

  it('retains exact integer objects when positive uint64 overflow accompanies uint64 and NA', () => {
    expect(
      toNumericColumn({ name: 'a', cells: ['9223372036854775808', '18446744073709551616', 'NA'] }),
    ).toEqual({
      values: Float64Array.of(9.223372036854776e18, 1.8446744073709552e19, Number.NaN),
      missingCount: 1,
      coercedCount: 0,
    })
  })

  it.each(['', '-'])('rejects a %s309-digit integer as a load failure', (sign) => {
    // read_csv raises OverflowError; detect_columns wraps it as DataLoadError.
    const table = parseCsvText(`t,a\n0,${sign}${'9'.repeat(309)}\n1,1\n`)
    expect(() => detectColumns(table)).toThrow(CsvParseError)
    expect(() => toNumericColumn(table.column('a') as never)).toThrowError(
      expect.objectContaining({ code: 'CSV_PARSE_FAILED' }),
    )
  })

  it.each(['', '-'])('defers later %s309-digit integer overflow until numeric conversion', (sign) => {
    // pandas loads Python integer objects when its first nonmissing value is
    // float-representable, but _to_numeric_series still rejects the later value.
    const table = parseCsvText(`t,a\n0,1\n1,${sign}${'9'.repeat(309)}\n`)
    expect(() => detectColumns(table)).not.toThrow()
    expect(isNumericColumn(table.column('a') as never)).toBe(false)
    expect(() => toNumericColumn(table.column('a') as never)).toThrowError(
      expect.objectContaining({ code: 'CSV_PARSE_FAILED' }),
    )
  })

  it('accepts a float-representable 309-digit integer', () => {
    expect(toNumericColumn({ name: 'a', cells: [`1${'0'.repeat(308)}`, 'NA'] })).toEqual({
      values: Float64Array.of(1e308, Number.NaN),
      missingCount: 1,
      coercedCount: 0,
    })
  })

  it.each([
    {
      cells: ['9'.repeat(309), '1.5', 'NA'],
      values: [Number.POSITIVE_INFINITY, 1.5, Number.NaN],
      missingCount: 0,
      coercedCount: 1,
    },
    {
      cells: ['1.5', '9'.repeat(309), 'NA'],
      values: [1.5, Number.POSITIVE_INFINITY, Number.NaN],
      missingCount: 1,
      coercedCount: 0,
    },
    {
      cells: [`-${'9'.repeat(309)}`, '9223372036854775808', 'NA'],
      values: [Number.NEGATIVE_INFINITY, 9.223372036854778e18, Number.NaN],
      missingCount: 0,
      coercedCount: 1,
    },
  ])(
    'preserves pandas overflow behavior outside integer-object conversion (case $coercedCount/$missingCount)',
    ({ cells, values, missingCount, coercedCount }) => {
      expect(toNumericColumn({ name: 'a', cells })).toEqual({
        values: Float64Array.from(values),
        missingCount,
        coercedCount,
      })
    },
  )

  it('keeps the float parser for integer tokens mixed with decimal or text cells', () => {
    expect(Array.from(toNumericColumn({ name: 'a', cells: ['0000000000000000001', '1.0'] }).values)).toEqual([
      0, 1,
    ])
    expect(Array.from(toNumericColumn({ name: 'a', cells: ['0000000000000000001', 'ERR'] }).values)).toEqual([
      0,
      Number.NaN,
    ])
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

  it('treats the infinity spellings as numeric, matching float64 inference', () => {
    const table = parseCsvText('t,a\n0.0,inf\n0.001,-Infinity\n')
    expect(isNumericColumn(table.column('a') as never)).toBe(true)
  })

  it('respects the first uint64 overflow when mixed with decimal cells', () => {
    expect(isNumericColumn({ name: 'a', cells: ['18446744073709551616', '1.0'] })).toBe(false)
    expect(isNumericColumn({ name: 'a', cells: ['1.0', '18446744073709551616'] })).toBe(true)
  })

  it('keeps bool columns un-numeric when a missing or numeric cell makes them object dtype', () => {
    // bool dtype cannot hold NaN, and booleans mixed with numbers are object.
    const gapped = parseCsvText('a,b\nTrue,1\n,x\nFalse,2\n')
    expect(isNumericColumn(gapped.column('a') as never)).toBe(false)
    const mixed = parseCsvText('a\nTrue\n1.0\nFalse\n')
    expect(isNumericColumn(mixed.column('a') as never)).toBe(false)
  })
})

describe('detectColumns', () => {
  it('offers no numeric candidates for a header-only table', () => {
    expect(detectColumns(parseCsvText('x,y\n'))).toEqual({ time: [], acceleration: [] })
  })

  it('includes Python IGNORECASE equivalents without changing word boundaries', () => {
    const table = parseCsvText('tıme,Time,acc\n0,10,1\n1,11,1\n')
    expect(detectColumns(table)).toEqual({ time: ['tıme', 'Time'], acceleration: ['acc'] })
    expect(detectColumns(parseCsvText('TİME,ſec,Ktime,acc\n0,1,2,3\n')).time).toEqual(['ſec'])
    expect(detectColumns(parseCsvText('TİME,Time,acc\n0,1,2\n')).time).toEqual(['Time'])
  })

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
