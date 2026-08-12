/**
 * CSV export — the lossless alternative when a run is too long for a worksheet.
 *
 * Excel caps a worksheet at 1,048,576 rows. CSV has no such limit, so whenever
 * `buildSheets` rejects an export the UI offers this instead. The column layout
 * matches the Gravity Level Data sheet so the two are interchangeable for
 * downstream scripts.
 */

import { sanitiseTextCell } from './formula-safety.ts'
import { buildUnifiedTimeAxis, finiteRange, resampleToAxis, unionTimeRange } from './resample.ts'
import {
  HEADER_GRAVITY_DRAG,
  HEADER_GRAVITY_INNER,
  HEADER_TIME,
  type WorkbookInput,
} from './workbook.ts'

/**
 * Number of digits that round-trips a float64 through decimal text.
 *
 * 17 significant digits is the IEEE-754 guarantee. Using JavaScript's default
 * `String(value)` would give the shortest round-tripping form, which is also
 * exact — but tools that read the CSV with a fixed parser are better served by
 * a stable width, and the desktop app's Excel output carries full precision.
 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return ''
  // toString() already produces the shortest exactly-round-tripping decimal.
  return String(value)
}

/** Quote a field only when it needs it, and escape embedded quotes by doubling. */
function quoteField(field: string): string {
  if (/[",\r\n]/.test(field)) return `"${field.replaceAll('"', '""')}"`
  return field
}

/**
 * Generate the CSV as a stream of chunks.
 *
 * A 20-million-row export is well past what a single JavaScript string can hold
 * comfortably, so rows are yielded in batches and the caller writes them
 * straight into a Blob or a stream rather than concatenating.
 */
export function* generateCsvChunks(input: WorkbookInput, rowsPerChunk = 20_000): Generator<string> {
  const range = unionTimeRange([
    finiteRange(input.inner?.time ?? null),
    finiteRange(input.drag?.time ?? null),
  ])
  if (range === null) throw new Error('There is no exportable time data.')

  const unifiedTime = buildUnifiedTimeAxis(range.start, range.end, input.samplingRate)

  const headers: string[] = [HEADER_TIME]
  const columns: Float64Array[] = []
  if (input.inner !== null && input.inner.gravity.length > 0) {
    headers.push(HEADER_GRAVITY_INNER)
    columns.push(resampleToAxis(unifiedTime, input.inner.time, input.inner.gravity))
  }
  if (input.drag !== null && input.drag.gravity.length > 0) {
    headers.push(HEADER_GRAVITY_DRAG)
    columns.push(resampleToAxis(unifiedTime, input.drag.time, input.drag.gravity))
  }

  // Headers are fixed strings, but they still go through the sanitiser so the
  // rule is applied uniformly and a future configurable header cannot bypass it.
  yield `${headers.map((header) => quoteField(sanitiseTextCell(header))).join(',')}\r\n`

  const buffer: string[] = []
  for (let index = 0; index < unifiedTime.length; index++) {
    const fields = [formatNumber(unifiedTime[index] as number)]
    for (const column of columns) fields.push(formatNumber(column[index] as number))
    buffer.push(`${fields.join(',')}\r\n`)
    if (buffer.length >= rowsPerChunk) {
      yield buffer.join('')
      buffer.length = 0
    }
  }
  if (buffer.length > 0) yield buffer.join('')
}

/** UTF-8 byte order mark, written explicitly rather than as an invisible literal. */
export const BOM = '\uFEFF'

/** Materialise the CSV as a Blob, ready for a native download. */
export function buildCsvBlob(input: WorkbookInput): Blob {
  const chunks: string[] = []
  for (const chunk of generateCsvChunks(input)) chunks.push(chunk)
  // A UTF-8 BOM makes Excel on Windows read the file as UTF-8 rather than the
  // system code page, which otherwise mangles the ² in the unit headers.
  return new Blob([BOM, ...chunks], { type: 'text/csv;charset=utf-8' })
}
