/**
 * Main-thread client for the analysis worker.
 *
 * Turns the message protocol into promises, keeps one worker for the whole
 * session (spawning one per file would pay the module-instantiation cost every
 * time and lose the retained tables), and routes progress to a callback.
 *
 * The worker is created lazily so that simply loading the application does not
 * start it — a user who opens the page to read the settings never pays for it.
 */

import type { AnalysisConfig } from '@aat/shared'
import type {
  AnalyseRequest,
  AnalysisPayload,
  AnalysisStage,
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  ColumnMapping,
  OpenedSource,
} from './protocol.ts'

export interface AnalysisProgress {
  stage: AnalysisStage
  percent: number
}

/**
 * A failure that crossed the worker boundary.
 *
 * `code` is the engine's stable code (`COLUMN_NOT_FOUND`, `CSV_DECODE_FAILED`,
 * ...), which is what the UI branches on — `COLUMN_NOT_FOUND` in particular
 * reopens the column selector rather than showing a dead end.
 */
export class AnalysisWorkerError extends Error {
  readonly code: string
  readonly missingColumns: readonly string[]
  readonly availableColumns: readonly string[]

  constructor(code: string, message: string, missing: readonly string[], available: readonly string[]) {
    super(message)
    this.name = 'AnalysisWorkerError'
    this.code = code
    this.missingColumns = missing
    this.availableColumns = available
  }
}

interface PendingRequest {
  resolve: (value: never) => void
  reject: (error: Error) => void
  onProgress: ((progress: AnalysisProgress) => void) | undefined
  expect: 'opened' | 'analysed' | 'released'
}

export interface AnalysedResult {
  payload: AnalysisPayload
  fromCache: boolean
}

export class AnalysisClient {
  private worker: Worker | null = null
  private nextRequestId = 0
  private readonly pending = new Map<string, PendingRequest>()

  private ensureWorker(): Worker {
    if (this.worker !== null) return this.worker
    // `new URL(..., import.meta.url)` is the form Vite recognises for bundling a
    // worker; a bare string would only work in development.
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), {
      type: 'module',
      name: 'aat-analysis',
    })
    worker.addEventListener('message', (event: MessageEvent<AnalysisWorkerResponse>) => {
      this.handleMessage(event.data)
    })
    worker.addEventListener('error', (event) => {
      // A worker-level error is not attributable to one request, so every
      // in-flight request fails rather than hanging forever.
      const error = new AnalysisWorkerError('WORKER_FAILED', event.message, [], [])
      for (const [, request] of this.pending) request.reject(error)
      this.pending.clear()
    })
    this.worker = worker
    return worker
  }

  private handleMessage(message: AnalysisWorkerResponse): void {
    const request = this.pending.get(message.requestId)
    if (request === undefined) return

    if (message.type === 'progress') {
      request.onProgress?.({ stage: message.stage, percent: message.percent })
      return
    }

    this.pending.delete(message.requestId)

    if (message.type === 'error') {
      request.reject(
        new AnalysisWorkerError(
          message.code,
          message.message,
          message.missingColumns ?? [],
          message.availableColumns ?? [],
        ),
      )
      return
    }

    if (message.type === 'opened' && request.expect === 'opened') {
      ;(request.resolve as unknown as (value: OpenedSource) => void)(message.source)
      return
    }
    if (message.type === 'analysed' && request.expect === 'analysed') {
      ;(request.resolve as unknown as (value: AnalysedResult) => void)({
        payload: message.payload,
        fromCache: message.fromCache,
      })
      return
    }
    if (message.type === 'released' && request.expect === 'released') {
      ;(request.resolve as unknown as () => void)()
      return
    }

    request.reject(
      new AnalysisWorkerError('PROTOCOL_MISMATCH', `Unexpected '${message.type}' response`, [], []),
    )
  }

  private send<T>(
    request: AnalysisWorkerRequest,
    expect: PendingRequest['expect'],
    transfer: Transferable[],
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<T> {
    const worker = this.ensureWorker()
    return new Promise<T>((resolve, reject) => {
      this.pending.set(request.requestId, {
        resolve: resolve as unknown as (value: never) => void,
        reject,
        onProgress,
        expect,
      })
      worker.postMessage(request, transfer)
    })
  }

  private id(): string {
    this.nextRequestId += 1
    return `r${this.nextRequestId}`
  }

  /**
   * Decode, parse and detect columns.
   *
   * `bytes` is transferred: the caller must not read the buffer afterwards. A
   * `File` read gives a fresh `ArrayBuffer` each time, so this costs nothing and
   * saves a full copy of the file.
   */
  open(
    filename: string,
    bytes: ArrayBuffer,
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<OpenedSource> {
    return this.send<OpenedSource>(
      { type: 'open', requestId: this.id(), filename, bytes },
      'opened',
      [bytes],
      onProgress,
    )
  }

  /** Run the numerical pipeline over a source the worker already parsed. */
  analyse(
    options: {
      sourceSha256: string
      filename: string
      config: AnalysisConfig
      mapping: ColumnMapping
      skipGQuality: boolean
      useCache: boolean
    },
    onProgress?: (progress: AnalysisProgress) => void,
  ): Promise<AnalysedResult> {
    const request: AnalyseRequest = {
      type: 'analyse',
      requestId: this.id(),
      sourceSha256: options.sourceSha256,
      filename: options.filename,
      config: options.config,
      mapping: options.mapping,
      skipGQuality: options.skipGQuality,
      useCache: options.useCache,
    }
    return this.send<AnalysedResult>(request, 'analysed', [], onProgress)
  }

  /** Let the worker drop a parsed table when its dataset is closed. */
  release(sourceSha256: string): Promise<void> {
    return this.send<void>({ type: 'release', requestId: this.id(), sourceSha256 }, 'released', [])
  }

  /** Shut the worker down. Used when the application unmounts. */
  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}
