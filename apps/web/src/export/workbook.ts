/**
 * Excel export — port of `core/export.py`'s workbook shape.
 *
 * The sheet names, column headers and semantics are a compatibility contract:
 * researchers have downstream scripts and templates keyed to them, so they are
 * reproduced exactly. What is *not* reproduced is the desktop app's inability
 * to notice that its memory guard (20,000,000 samples) has nothing to do with
 * what a worksheet can hold (1,048,576 rows). See the row-limit section below.
 */

import type { RangeStatistics, WindowStatistics } from '@aat/analysis-core'
import { buildUnifiedTimeAxis, finiteRange, resampleToAxis, unionTimeRange } from './resample.ts'

/**
 * Hard limit of the XLSX format: 1,048,576 rows per worksheet, header included.
 *
 * This is a property of the file format, not a tunable. Exceeding it does not
 * produce a large file, it produces an invalid one.
 */
export const XLSX_MAX_ROWS = 1_048_576

/** Rows available for data once the header row is spent. */
export const XLSX_MAX_DATA_ROWS = XLSX_MAX_ROWS - 1

export const SHEET_GRAVITY_DATA = 'Gravity Level Data'
export const SHEET_GRAVITY_STATISTICS = 'Gravity Level Statistics'
export const SHEET_ACCELERATION_DATA = 'Acceleration Data'
export const SHEET_G_QUALITY = 'G-quality Analysis'

/** Header strings copied verbatim from `core/export.py`. */
export const HEADER_TIME = 'Time (s)'
export const HEADER_GRAVITY_INNER = 'Gravity Level (Inner Capsule) (G)'
export const HEADER_GRAVITY_DRAG = 'Gravity Level (Drag Shield) (G)'
export const HEADER_ACCEL_INNER = 'Acceleration (Inner Capsule) (m/s²)'
export const HEADER_ACCEL_DRAG = 'Acceleration (Drag Shield) (m/s²)'

export const STATISTICS_ROW_LABELS = [
  'Inner Capsule: Mean Gravity Level of the interval with the smallest standard deviation(G)',
  'Inner Capsule: Time at smallest Standard Deviation(s)',
  'Inner Capsule: smallest Standard Deviation(G)',
  'Drag Shield: Mean Gravity Level of the interval with the smallest standard deviation(G)',
  'Drag Shield: Time at smallest Standard Deviation(s)',
  'Drag Shield: smallest Standard Deviation(G)',
] as const

export const G_QUALITY_HEADERS = [
  'Window Size (s)',
  'Inner Capsule: Time at smallest Standard Deviation(s)',
  'Inner Capsule: Mean Gravity Level of the interval with the smallest standard deviation(G)',
  'Inner Capsule: smallest Standard Deviation(G)',
  'Drag Shield: Time at smallest Standard Deviation(s)',
  'Drag Shield: Mean Gravity Level of the interval with the smallest standard deviation(G)',
  'Drag Shield: smallest Standard Deviation(G)',
] as const

export class ExportTooLargeError extends Error {
  readonly code = 'EXPORT_TOO_LARGE'
  constructor(
    message: string,
    readonly requiredRows: number,
    readonly maxRows: number,
  ) {
    super(message)
    this.name = 'ExportTooLargeError'
  }
}

export interface SensorSeries {
  /** Each sensor carries its own time axis in AAT. */
  time: Float64Array
  gravity: Float64Array
  /** Raw acceleration on the sensor's synchronised axis, for the third sheet. */
  acceleration?: Float64Array | undefined
}

export interface GQualityRow {
  windowSize: number
  innerStartTime: number | null
  innerMean: number | null
  innerStd: number | null
  dragStartTime: number | null
  dragMean: number | null
  dragStd: number | null
}

export interface WorkbookInput {
  inner: SensorSeries | null
  drag: SensorSeries | null
  samplingRate: number
  statistics: { inner: WindowStatistics; drag: WindowStatistics }
  gQuality: GQualityRow[]
  /** Optional selected-range statistics, appended to the statistics sheet. */
  rangeStatistics?:
    | { xMin: number; xMax: number; inner: RangeStatistics; drag: RangeStatistics }
    | undefined
}

/** A single worksheet as write-excel-file's row/cell structure. */
type Cell = { value: string | number | null; type?: typeof String | typeof Number }
export type Sheet = { name: string; rows: Cell[][] }

/**
 * Plan the export without building it, so the UI can warn before the user
 * commits to a long operation — and so the row-limit failure is a clean,
 * explainable error rather than a corrupt file.
 */
export function planWorkbook(input: WorkbookInput): {
  unifiedTime: Float64Array
  dataRows: number
  fitsWorksheet: boolean
} {
  const range = unionTimeRange([finiteRange(input.inner?.time ?? null), finiteRange(input.drag?.time ?? null)])
  if (range === null) {
    throw new ExportTooLargeError('There is no exportable time data.', 0, XLSX_MAX_DATA_ROWS)
  }
  const unifiedTime = buildUnifiedTimeAxis(range.start, range.end, input.samplingRate)
  return {
    unifiedTime,
    dataRows: unifiedTime.length,
    fitsWorksheet: unifiedTime.length <= XLSX_MAX_DATA_ROWS,
  }
}

/**
 * Build the workbook sheets.
 *
 * Throws `ExportTooLargeError` rather than truncating. The desktop app's guard
 * allows 20,000,000 unified samples, which is roughly 19x what a worksheet can
 * hold, so this case is reachable with a legitimately long run at a high
 * sampling rate. Silently dropping rows would hand the user a file that looks
 * complete and is not; silently dropping a sensor would be worse. The caller is
 * expected to offer CSV, which has no such limit.
 */
export function buildSheets(input: WorkbookInput): Sheet[] {
  const plan = planWorkbook(input)
  if (!plan.fitsWorksheet) {
    throw new ExportTooLargeError(
      `This analysis needs ${plan.dataRows.toLocaleString()} data rows, but a single Excel ` +
        `worksheet holds at most ${XLSX_MAX_DATA_ROWS.toLocaleString()} (plus the header). ` +
        'Export as CSV instead, which has no row limit, or narrow the analysis range.',
      plan.dataRows,
      XLSX_MAX_DATA_ROWS,
    )
  }

  const { unifiedTime } = plan
  const sheets: Sheet[] = [
    gravityDataSheet(unifiedTime, input),
    statisticsSheet(input),
  ]

  const accelerationSheet = accelerationDataSheet(unifiedTime, input)
  if (accelerationSheet !== null) sheets.push(accelerationSheet)

  if (input.gQuality.length > 0) sheets.push(gQualitySheet(input.gQuality))
  return sheets
}

function numberCell(value: number | null): Cell {
  // NaN is how "outside this sensor's measured span" reaches here, and it must
  // become a blank cell rather than a zero or the string "NaN".
  if (value === null || !Number.isFinite(value)) return { value: null }
  return { value, type: Number }
}

function textCell(value: string): Cell {
  return { value, type: String }
}

function gravityDataSheet(unifiedTime: Float64Array, input: WorkbookInput): Sheet {
  const headers: Cell[] = [textCell(HEADER_TIME)]
  const columns: Float64Array[] = []

  if (input.inner !== null && input.inner.gravity.length > 0) {
    headers.push(textCell(HEADER_GRAVITY_INNER))
    columns.push(resampleToAxis(unifiedTime, input.inner.time, input.inner.gravity))
  }
  if (input.drag !== null && input.drag.gravity.length > 0) {
    headers.push(textCell(HEADER_GRAVITY_DRAG))
    columns.push(resampleToAxis(unifiedTime, input.drag.time, input.drag.gravity))
  }

  const rows: Cell[][] = [headers]
  for (let index = 0; index < unifiedTime.length; index++) {
    const row: Cell[] = [numberCell(unifiedTime[index] as number)]
    for (const column of columns) row.push(numberCell(column[index] as number))
    rows.push(row)
  }
  return { name: SHEET_GRAVITY_DATA, rows }
}

function statisticsSheet(input: WorkbookInput): Sheet {
  const { inner, drag } = input.statistics
  const values: Array<number | null> = [
    inner.mean,
    inner.startTime,
    inner.std,
    drag.mean,
    drag.startTime,
    drag.std,
  ]

  const rows: Cell[][] = [[textCell('Statistic'), textCell('Value')]]
  for (let index = 0; index < STATISTICS_ROW_LABELS.length; index++) {
    rows.push([textCell(STATISTICS_ROW_LABELS[index] as string), numberCell(values[index] ?? null)])
  }

  // Selected-range statistics are an AAT Web addition. They are appended after
  // the frozen six rows so any script reading by row index still works.
  const selection = input.rangeStatistics
  if (selection !== undefined) {
    rows.push([{ value: null }, { value: null }])
    rows.push([textCell(`Selected range (s)`), textCell(`${selection.xMin} – ${selection.xMax}`)])
    for (const [label, stats] of [
      ['Inner Capsule', selection.inner],
      ['Drag Shield', selection.drag],
    ] as const) {
      rows.push([textCell(`${label}: Selected range mean (G)`), numberCell(stats.mean)])
      rows.push([textCell(`${label}: Selected range mean of |G|`), numberCell(stats.absMean)])
      rows.push([textCell(`${label}: Selected range standard deviation (G)`), numberCell(stats.std)])
      rows.push([textCell(`${label}: Selected range minimum (G)`), numberCell(stats.min)])
      rows.push([textCell(`${label}: Selected range maximum (G)`), numberCell(stats.max)])
      rows.push([textCell(`${label}: Selected range span (G)`), numberCell(stats.range)])
      rows.push([textCell(`${label}: Selected range sample count`), numberCell(stats.count)])
      rows.push([textCell(`${label}: Selected range missing samples`), numberCell(stats.missing)])
    }
  }

  return { name: SHEET_GRAVITY_STATISTICS, rows }
}

function accelerationDataSheet(unifiedTime: Float64Array, input: WorkbookInput): Sheet | null {
  const headers: Cell[] = [textCell(HEADER_TIME)]
  const columns: Float64Array[] = []

  if (input.inner !== null && input.inner.acceleration !== undefined) {
    headers.push(textCell(HEADER_ACCEL_INNER))
    columns.push(resampleToAxis(unifiedTime, input.inner.time, input.inner.acceleration))
  }
  if (input.drag !== null && input.drag.acceleration !== undefined) {
    headers.push(textCell(HEADER_ACCEL_DRAG))
    columns.push(resampleToAxis(unifiedTime, input.drag.time, input.drag.acceleration))
  }
  if (columns.length === 0) return null

  const rows: Cell[][] = [headers]
  for (let index = 0; index < unifiedTime.length; index++) {
    const row: Cell[] = [numberCell(unifiedTime[index] as number)]
    for (const column of columns) row.push(numberCell(column[index] as number))
    rows.push(row)
  }
  return { name: SHEET_ACCELERATION_DATA, rows }
}

function gQualitySheet(rows: GQualityRow[]): Sheet {
  const sheetRows: Cell[][] = [G_QUALITY_HEADERS.map((header) => textCell(header))]
  for (const row of rows) {
    sheetRows.push([
      numberCell(row.windowSize),
      numberCell(row.innerStartTime),
      numberCell(row.innerMean),
      numberCell(row.innerStd),
      numberCell(row.dragStartTime),
      numberCell(row.dragMean),
      numberCell(row.dragStd),
    ])
  }
  return { name: SHEET_G_QUALITY, rows: sheetRows }
}
