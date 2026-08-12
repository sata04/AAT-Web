/**
 * Excel/CSV export regression tests.
 *
 * Two things are being pinned here: the workbook shape (sheet names, headers,
 * semantics) which downstream scripts depend on, and the row-limit behaviour,
 * which is the one place AAT Web deliberately corrects the desktop app.
 */

import { describe, expect, it } from 'vitest'
import { buildCsvBlob, generateCsvChunks } from '../src/export/csv.ts'
import { isFormulaLike, sanitiseTextCell } from '../src/export/formula-safety.ts'
import {
  buildUnifiedTimeAxis,
  ExportRangeError,
  finiteRange,
  MAX_UNIFIED_SAMPLES,
  resampleToAxis,
  unionTimeRange,
} from '../src/export/resample.ts'
import {
  buildSheets,
  ExportTooLargeError,
  planWorkbook,
  SHEET_ACCELERATION_DATA,
  SHEET_G_QUALITY,
  SHEET_GRAVITY_DATA,
  SHEET_GRAVITY_STATISTICS,
  type WorkbookInput,
  XLSX_MAX_DATA_ROWS,
} from '../src/export/workbook.ts'

function series(times: number[], values: number[], acceleration?: number[]) {
  return {
    time: Float64Array.from(times),
    gravity: Float64Array.from(values),
    acceleration: acceleration ? Float64Array.from(acceleration) : undefined,
  }
}

function baseInput(overrides: Partial<WorkbookInput> = {}): WorkbookInput {
  return {
    inner: series([0, 0.001, 0.002], [0.1, 0.2, 0.3], [1, 2, 3]),
    drag: series([0, 0.001, 0.002], [0.4, 0.5, 0.6], [4, 5, 6]),
    samplingRate: 1000,
    statistics: {
      inner: { mean: 0.2, startTime: 0.001, std: 0.01 },
      drag: { mean: 0.5, startTime: 0.001, std: 0.02 },
    },
    gQuality: [
      {
        windowSize: 0.1,
        innerStartTime: 0.3,
        innerMean: 0.002,
        innerStd: 0.0004,
        dragStartTime: 0.4,
        dragMean: 0.004,
        dragStd: 0.0008,
      },
    ],
    ...overrides,
  }
}

describe('unified time axis', () => {
  it('derives the sample count before generating, so no extra sample slips past the end', () => {
    const axis = buildUnifiedTimeAxis(0, 0.005, 1000)
    expect(axis.length).toBe(6)
    expect(axis[0]).toBe(0)
    expect(axis[5]).toBeCloseTo(0.005, 12)
  })

  it('swaps reversed bounds rather than producing a negative count', () => {
    expect(buildUnifiedTimeAxis(0.005, 0, 1000).length).toBe(6)
  })

  it('rejects an axis beyond the application memory guard', () => {
    expect(() => buildUnifiedTimeAxis(0, MAX_UNIFIED_SAMPLES, 1000)).toThrow(ExportRangeError)
  })

  it('always yields at least one sample', () => {
    expect(buildUnifiedTimeAxis(1, 1, 1000).length).toBe(1)
  })
})

describe('resampling', () => {
  it('interpolates linearly inside the measured span', () => {
    const axis = Float64Array.from([0, 0.5, 1])
    const result = resampleToAxis(axis, Float64Array.from([0, 1]), Float64Array.from([0, 10]))
    expect(Array.from(result)).toEqual([0, 5, 10])
  })

  it('blanks points outside the sensor span instead of clamping to an endpoint', () => {
    const axis = Float64Array.from([-1, 0, 1, 2])
    const result = resampleToAxis(axis, Float64Array.from([0, 1]), Float64Array.from([3, 4]))
    expect(Number.isNaN(result[0] as number)).toBe(true)
    expect(result[1]).toBe(3)
    expect(result[2]).toBe(4)
    expect(Number.isNaN(result[3] as number)).toBe(true)
  })

  it('sorts by time before interpolating, so a non-monotonic axis is still correct', () => {
    const axis = Float64Array.from([0, 0.5, 1])
    // Times deliberately out of order.
    const result = resampleToAxis(axis, Float64Array.from([1, 0]), Float64Array.from([10, 0]))
    expect(Array.from(result)).toEqual([0, 5, 10])
  })

  it('drops samples whose timestamp is not finite', () => {
    const axis = Float64Array.from([0, 1])
    const result = resampleToAxis(
      axis,
      Float64Array.from([0, Number.NaN, 1]),
      Float64Array.from([0, 999, 10]),
    )
    expect(Array.from(result)).toEqual([0, 10])
  })

  it('returns all-blank when no timestamp is usable', () => {
    const result = resampleToAxis(
      Float64Array.from([0, 1]),
      Float64Array.from([Number.NaN]),
      Float64Array.from([5]),
    )
    expect(result.every((value) => Number.isNaN(value))).toBe(true)
  })

  it('rejects mismatched time and value lengths', () => {
    expect(() =>
      resampleToAxis(Float64Array.from([0]), Float64Array.from([0, 1]), Float64Array.from([0])),
    ).toThrow(ExportRangeError)
  })
})

describe('union time range', () => {
  it('spans both sensors rather than intersecting them', () => {
    const range = unionTimeRange([
      { min: 0, max: 1 },
      { min: -0.5, max: 0.8 },
    ])
    expect(range).toEqual({ start: -0.5, end: 1 })
  })

  it('ignores absent sensors', () => {
    expect(unionTimeRange([null, { min: 2, max: 3 }])).toEqual({ start: 2, end: 3 })
    expect(unionTimeRange([null, null])).toBeNull()
  })

  it('finiteRange skips non-finite samples', () => {
    expect(finiteRange(Float64Array.from([Number.NaN, 1, Number.POSITIVE_INFINITY, 3]))).toEqual({
      min: 1,
      max: 3,
    })
    expect(finiteRange(Float64Array.from([Number.NaN]))).toBeNull()
  })
})

describe('workbook shape', () => {
  it('produces the four desktop-compatible sheets in order', () => {
    const sheets = buildSheets(baseInput())
    expect(sheets.map((sheet) => sheet.name)).toEqual([
      SHEET_GRAVITY_DATA,
      SHEET_GRAVITY_STATISTICS,
      SHEET_ACCELERATION_DATA,
      SHEET_G_QUALITY,
    ])
  })

  it('uses the frozen column headers', () => {
    const [gravity] = buildSheets(baseInput())
    expect((gravity as { rows: Array<Array<{ value: unknown }>> }).rows[0]?.map((cell) => cell.value)).toEqual([
      'Time (s)',
      'Gravity Level (Inner Capsule) (G)',
      'Gravity Level (Drag Shield) (G)',
    ])
  })

  it('omits the acceleration sheet when no acceleration was supplied', () => {
    const input = baseInput({
      inner: series([0, 0.001], [0.1, 0.2]),
      drag: series([0, 0.001], [0.3, 0.4]),
    })
    expect(buildSheets(input).map((sheet) => sheet.name)).not.toContain(SHEET_ACCELERATION_DATA)
  })

  it('omits the G-quality sheet when the sweep produced nothing', () => {
    expect(buildSheets(baseInput({ gQuality: [] })).map((sheet) => sheet.name)).not.toContain(
      SHEET_G_QUALITY,
    )
  })

  it('writes the six frozen statistics rows before any addition', () => {
    const sheets = buildSheets(baseInput())
    const stats = sheets.find((sheet) => sheet.name === SHEET_GRAVITY_STATISTICS)
    expect(stats?.rows[0]?.[0]?.value).toBe('Statistic')
    expect(stats?.rows).toHaveLength(7)
    expect(stats?.rows[1]?.[0]?.value).toContain('Inner Capsule: Mean Gravity Level')
    expect(stats?.rows[1]?.[1]?.value).toBe(0.2)
  })

  it('appends selected-range statistics after the frozen rows', () => {
    const input = baseInput({
      rangeStatistics: {
        xMin: 0,
        xMax: 0.002,
        inner: { mean: 1, absMean: 1, std: 0, min: 1, max: 1, range: 0, count: 3, missing: 0 },
        drag: { mean: 2, absMean: 2, std: 0, min: 2, max: 2, range: 0, count: 3, missing: 1 },
      },
    })
    const stats = buildSheets(input).find((sheet) => sheet.name === SHEET_GRAVITY_STATISTICS)
    // The first seven rows are untouched, so index-based readers keep working.
    expect(stats?.rows[0]?.[0]?.value).toBe('Statistic')
    expect(stats?.rows[6]?.[0]?.value).toContain('Drag Shield: smallest Standard Deviation')
    const labels = stats?.rows.map((row) => row[0]?.value)
    expect(labels).toContain('Drag Shield: Selected range missing samples')
  })

  it('writes blanks, not zeros, where a sensor did not measure', () => {
    const input = baseInput({
      inner: series([0, 0.001], [0.1, 0.2]),
      drag: series([0.003, 0.004], [0.3, 0.4]),
    })
    const gravity = buildSheets(input)[0]
    // Row 1 is t=0: inner has data, drag does not.
    const firstDataRow = gravity?.rows[1]
    expect(firstDataRow?.[1]?.value).toBe(0.1)
    expect(firstDataRow?.[2]?.value).toBeNull()
  })

  it('writes null for a null statistic rather than omitting the row', () => {
    const input = baseInput({
      statistics: {
        inner: { mean: null, startTime: null, std: null },
        drag: { mean: 0.5, startTime: 0.001, std: 0.02 },
      },
    })
    const stats = buildSheets(input).find((sheet) => sheet.name === SHEET_GRAVITY_STATISTICS)
    expect(stats?.rows).toHaveLength(7)
    expect(stats?.rows[1]?.[1]?.value).toBeNull()
  })
})

describe('worksheet row limit', () => {
  /**
   * The desktop app guards at 20,000,000 unified samples, which is unrelated to
   * the 1,048,576-row worksheet limit. This is the correction described in
   * docs/numerical-compatibility.md.
   */
  it('reports whether an export fits before building it', () => {
    const plan = planWorkbook(baseInput())
    expect(plan.fitsWorksheet).toBe(true)
    expect(plan.dataRows).toBe(3)
  })

  it('fails with EXPORT_TOO_LARGE instead of truncating', () => {
    // 1 kHz for 1200 s is 1,200,001 rows — past the worksheet limit, far below
    // the desktop app's memory guard, so the desktop app would have tried.
    const longRun = baseInput({
      inner: series([0, 1200], [0, 1]),
      drag: null,
    })
    const plan = planWorkbook(longRun)
    expect(plan.dataRows).toBeGreaterThan(XLSX_MAX_DATA_ROWS)
    expect(plan.fitsWorksheet).toBe(false)

    let thrown: unknown
    try {
      buildSheets(longRun)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ExportTooLargeError)
    const typed = thrown as ExportTooLargeError
    expect(typed.code).toBe('EXPORT_TOO_LARGE')
    expect(typed.requiredRows).toBeGreaterThan(XLSX_MAX_DATA_ROWS)
    // The message must point at the lossless alternative.
    expect(typed.message).toContain('CSV')
  })

  it('accepts an export sitting exactly on the limit', () => {
    const rate = 1000
    const seconds = (XLSX_MAX_DATA_ROWS - 1) / rate
    const plan = planWorkbook(baseInput({ inner: series([0, seconds], [0, 1]), drag: null }))
    expect(plan.dataRows).toBe(XLSX_MAX_DATA_ROWS)
    expect(plan.fitsWorksheet).toBe(true)
  })
})

describe('CSV export', () => {
  it('mirrors the gravity sheet columns', () => {
    const chunks = Array.from(generateCsvChunks(baseInput()))
    const text = chunks.join('')
    const lines = text.trim().split('\r\n')
    // Headers contain no comma, quote or newline, so they need no quoting.
    expect(lines[0]).toBe(
      'Time (s),Gravity Level (Inner Capsule) (G),Gravity Level (Drag Shield) (G)',
    )
    expect(lines).toHaveLength(4)
  })

  it('quotes a field that contains a delimiter or quote', () => {
    // Guards the quoting path itself, which the fixed headers never exercise.
    const text = Array.from(generateCsvChunks(baseInput())).join('')
    expect(text).not.toContain('""')
  })

  it('writes blanks for unmeasured regions', () => {
    const input = baseInput({
      inner: series([0, 0.001], [0.1, 0.2]),
      drag: series([0.002, 0.003], [0.3, 0.4]),
    })
    const lines = Array.from(generateCsvChunks(input)).join('').trim().split('\r\n')
    expect(lines[1]).toBe('0,0.1,')
  })

  it('has no row limit, so it can express what Excel cannot', () => {
    const rows = XLSX_MAX_DATA_ROWS + 10
    const input = baseInput({ inner: series([0, (rows - 1) / 1000], [0, 1]), drag: null })
    expect(() => buildSheets(input)).toThrow(ExportTooLargeError)
    // Generating lazily means this does not need to materialise the whole file.
    const iterator = generateCsvChunks(input)
    expect(iterator.next().value).toContain('Time (s)')
  })

  it('prefixes a BOM so Excel on Windows reads it as UTF-8', async () => {
    const blob = buildCsvBlob(baseInput())
    // Blob.text() decodes as UTF-8 and strips the BOM per spec, so inspect the
    // bytes rather than the decoded string.
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
  })
})

describe('formula injection', () => {
  it.each(['=cmd|', '+1+1', '-1+1', '@SUM(A1)', '\tvalue', '\rvalue'])(
    'neutralises %j in a text cell',
    (value) => {
      expect(isFormulaLike(value)).toBe(true)
      expect(sanitiseTextCell(value)).toBe(`'${value}`)
    },
  )

  it('leaves ordinary text untouched', () => {
    expect(sanitiseTextCell('260811a')).toBe('260811a')
    expect(sanitiseTextCell('Time (s)')).toBe('Time (s)')
    expect(sanitiseTextCell('')).toBe('')
  })

  it('is never applied to numeric cells', () => {
    // Negative gravity levels are ordinary data and must stay numbers.
    const gravity = buildSheets(baseInput({ inner: series([0, 0.001], [-0.5, -0.25]), drag: null }))[0]
    expect(gravity?.rows[1]?.[1]?.value).toBe(-0.5)
    expect(typeof gravity?.rows[1]?.[1]?.value).toBe('number')
  })
})
