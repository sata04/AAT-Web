/**
 * Main-thread client for the export worker, plus the file-save step.
 *
 * The dataset is *copied* into the worker rather than transferred: transferring
 * would detach the buffers the graph is drawing from, and an export must never
 * cost the user the analysis they were looking at.
 */

import type { WorkbookInput } from '../export/workbook.ts'
import type { ExportRequest, ExportResponse } from './export.worker.ts'

export class ExportTooLargeForWorksheet extends Error {
  readonly requiredRows: number
  readonly maxRows: number

  constructor(message: string, requiredRows: number, maxRows: number) {
    super(message)
    this.name = 'ExportTooLargeForWorksheet'
    this.requiredRows = requiredRows
    this.maxRows = maxRows
  }
}

export interface ExportResult {
  blob: Blob
  dataRows: number | null
}

interface Pending {
  resolve: (value: ExportResult) => void
  reject: (error: Error) => void
}

export class ExportClient {
  private worker: Worker | null = null
  private nextId = 0
  private readonly pending = new Map<string, Pending>()

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), {
      type: 'module',
      name: 'aat-export',
    })
    worker.addEventListener('message', (event: MessageEvent<ExportResponse>) => {
      const message = event.data
      const request = this.pending.get(message.requestId)
      if (request === undefined) return
      this.pending.delete(message.requestId)

      if (message.type === 'done') {
        request.resolve({ blob: message.blob, dataRows: message.dataRows })
        return
      }
      if (message.code === 'EXPORT_TOO_LARGE') {
        request.reject(
          new ExportTooLargeForWorksheet(message.message, message.requiredRows ?? 0, message.maxRows ?? 0),
        )
        return
      }
      request.reject(new Error(message.message))
    })
    worker.addEventListener('error', (event) => {
      for (const [, request] of this.pending) request.reject(new Error(event.message))
      this.pending.clear()
    })
    this.worker = worker
    return worker
  }

  run(format: 'xlsx' | 'csv', input: WorkbookInput): Promise<ExportResult> {
    const worker = this.ensureWorker()
    this.nextId += 1
    const requestId = `e${this.nextId}`
    return new Promise<ExportResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      const request: ExportRequest = { requestId, format, input }
      worker.postMessage(request)
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked on the next macrotask rather than immediately:
 * revoking synchronously after `click()` cancels the download in some browsers,
 * which is a hard bug to attribute after the fact.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    anchor.remove()
  }, 0)
}
