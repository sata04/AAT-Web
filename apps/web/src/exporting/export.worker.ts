/**
 * The export Web Worker: spreadsheet and CSV generation off the main thread.
 *
 * This is not a precaution, it is a measured decision. Building the cell
 * structures and zipping the workbook for a two-sensor, 200,000-sample run took
 * roughly 1.5 s and 4.5 s respectively on a warm Node 22 runtime on the
 * development machine — about six seconds during which a main-thread
 * implementation would not repaint, not answer a click, and not let the user
 * cancel. Even a modest 20,000-sample run cost well over a second. A file
 * export is exactly the operation a user starts and then expects to keep
 * working during, so it runs here.
 *
 * Note what is *not* done: this worker is spawned from the main thread, never
 * from inside the analysis worker. Nesting workers to reach the library's own
 * threading would put the whole dataset across a second structured-clone
 * boundary and buy nothing.
 */

/// <reference lib="webworker" />

import writeXlsxFile from 'write-excel-file'
import { generateCsvChunks } from '../export/csv.ts'
import { buildSheets, ExportTooLargeError, planWorkbook, type WorkbookInput } from '../export/workbook.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope

export interface ExportRequest {
  requestId: string
  format: 'xlsx' | 'csv'
  input: WorkbookInput
}

export interface ExportDoneMessage {
  type: 'done'
  requestId: string
  blob: Blob
  /** Data rows in the unified time axis, for the confirmation message. */
  dataRows: number
}

export interface ExportFailedMessage {
  type: 'failed'
  requestId: string
  code: 'EXPORT_TOO_LARGE' | 'EXPORT_FAILED'
  message: string
  requiredRows?: number
  maxRows?: number
}

export type ExportResponse = ExportDoneMessage | ExportFailedMessage

/** UTF-8 BOM, so Excel on Windows reads the CSV as UTF-8 rather than the code page. */
const BOM = '﻿'

async function buildXlsx(input: WorkbookInput): Promise<{ blob: Blob; dataRows: number }> {
  const plan = planWorkbook(input)
  const sheets = buildSheets(input)
  const blob = await writeXlsxFile(
    sheets.map((sheet) => ({ name: sheet.name, data: sheet.rows })),
    {},
  ).toBlob()
  return { blob, dataRows: plan.dataRows }
}

function buildCsv(input: WorkbookInput): { blob: Blob; dataRows: number } {
  // Streamed in chunks rather than concatenated: a 20-million-row export is well
  // past what one JavaScript string should hold, and `Blob` accepts the parts.
  const parts: BlobPart[] = [BOM]
  let dataRows = 0
  for (const chunk of generateCsvChunks(input)) {
    parts.push(chunk)
    // The first chunk carries the header row; every later row is data.
    dataRows += chunk.split('\r\n').length - 1
  }
  // Subtract the header row counted above.
  return { blob: new Blob(parts, { type: 'text/csv;charset=utf-8' }), dataRows: Math.max(0, dataRows - 1) }
}

scope.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  const request = event.data
  const run = async (): Promise<void> => {
    const result = request.format === 'xlsx' ? await buildXlsx(request.input) : buildCsv(request.input)
    scope.postMessage({
      type: 'done',
      requestId: request.requestId,
      blob: result.blob,
      dataRows: result.dataRows,
    } satisfies ExportDoneMessage)
  }

  run().catch((error: unknown) => {
    if (error instanceof ExportTooLargeError) {
      scope.postMessage({
        type: 'failed',
        requestId: request.requestId,
        code: 'EXPORT_TOO_LARGE',
        message: error.message,
        requiredRows: error.requiredRows,
        maxRows: error.maxRows,
      } satisfies ExportFailedMessage)
      return
    }
    scope.postMessage({
      type: 'failed',
      requestId: request.requestId,
      code: 'EXPORT_FAILED',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ExportFailedMessage)
  })
})
