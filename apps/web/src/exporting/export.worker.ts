/**
 * The export Web Worker: spreadsheet and CSV generation off the main thread.
 *
 * This is not a precaution, it is a measured decision. Building the cell
 * structures and zipping the workbook for a two-sensor, 200,000-sample run took
 * roughly 1.5 s and 4.5 s respectively on a warm Node 22 runtime on the
 * development machine — about six seconds during which a main-thread
 * implementation would not repaint, not answer a click, and not let the user
 * cancel. Even a modest 20,000-sample run cost well over a second. Exporting is
 * exactly the operation a user starts and then expects to keep working during,
 * so it happens here.
 *
 * Note what is deliberately *not* done: this worker is spawned from the main
 * thread, never from inside the analysis worker. Nesting workers to reach a
 * library's own threading would push the whole dataset across a second
 * structured-clone boundary and buy nothing.
 */

/// <reference lib="webworker" />

import writeXlsxFile from 'write-excel-file/browser'
import { BOM, generateCsvChunks } from '../export/csv.ts'
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
  /**
   * Data rows on the unified time axis. Null for CSV, where counting them would
   * mean a second pass over the generated text purely to produce a number for a
   * confirmation message.
   */
  dataRows: number | null
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

async function buildXlsx(input: WorkbookInput): Promise<{ blob: Blob; dataRows: number }> {
  // `planWorkbook` first: it is what decides whether the row limit is exceeded,
  // and finding that out before building a million cell objects is the
  // difference between a clean error and a long wait followed by one.
  const plan = planWorkbook(input)
  const sheets = buildSheets(input)
  // The library's `Cell` type models a cell as a union that includes bare
  // values; the sheets from `src/export/` are always cell objects with an
  // explicit `type`, which is a strict subset. The cast states that.
  const data = sheets.map((sheet) => ({ name: sheet.name, data: sheet.rows })) as Parameters<
    typeof writeXlsxFile
  >[0]
  const blob = await writeXlsxFile(data).toBlob()
  return { blob, dataRows: plan.dataRows }
}

function buildCsv(input: WorkbookInput): Blob {
  // Streamed in chunks rather than concatenated: a 20-million-row export is well
  // past what a single JavaScript string should hold, and `Blob` takes parts.
  const parts: BlobPart[] = [BOM]
  for (const chunk of generateCsvChunks(input)) parts.push(chunk)
  return new Blob(parts, { type: 'text/csv;charset=utf-8' })
}

scope.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  const request = event.data
  const run = async (): Promise<void> => {
    if (request.format === 'xlsx') {
      const result = await buildXlsx(request.input)
      scope.postMessage({
        type: 'done',
        requestId: request.requestId,
        blob: result.blob,
        dataRows: result.dataRows,
      } satisfies ExportDoneMessage)
      return
    }
    scope.postMessage({
      type: 'done',
      requestId: request.requestId,
      blob: buildCsv(request.input),
      dataRows: null,
    } satisfies ExportDoneMessage)
  }

  run().catch((error: unknown) => {
    if (error instanceof ExportTooLargeError) {
      // Relayed with its numbers intact so the UI can say how many rows the run
      // needs and offer CSV, rather than truncating anything.
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
