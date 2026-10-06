/**
 * Public API of the in-browser poster engine — the replacement for the poster container's
 * `POST /render`. W2's request layer depends on these exact signatures.
 *
 * Nothing Pyodide-related exists until the first `renderPosterPng` call: the worker is spawned
 * lazily, so importing this module is free and the ~26 MiB engine download only ever happens
 * when somebody actually asks for a poster. After that first render the WASM and wheels are
 * held by the service worker's runtime cache (`/pyodide/<version>/`, CacheFirst — the URLs are
 * versioned, hence immutable), which is what makes repeat renders work offline.
 */

import type { PosterPlotSpec } from '@aat/plot-spec'
import pyodidePackage from 'pyodide/package.json'

import { PosterEngineError, type PosterEngineStatus } from './engine-core.ts'

export type { PosterEngineStatus }
export { PosterEngineError }

interface WorkerRenderedMessage {
  type: 'rendered'
  id: number
  ok: boolean
  png?: Uint8Array
  kind?: 'spec' | 'engine'
  code?: string
  message?: string
  field?: string | undefined
}

type WorkerOutbound =
  | WorkerRenderedMessage
  | { type: 'status'; status: PosterEngineStatus }
  | { type: 'ready'; version: string }

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, { resolve: (png: Uint8Array) => void; reject: (error: Error) => void }>()

let currentStatus: PosterEngineStatus = { kind: 'idle' }
const listeners = new Set<(status: PosterEngineStatus) => void>()

/**
 * The engine version string stamped onto stored poster records. Before the worker has booted
 * this honestly reports only the loader version it *would* boot; once booted (the worker pushes
 * its measured matplotlib/numpy/pillow versions on `ready`) it reports the full form, e.g.
 * `pyodide-314.0.7/matplotlib-3.10.8/numpy-2.4.6/pillow-12.2.0`.
 */
let engineVersion = `pyodide-${pyodidePackage.version}`

function setStatus(status: PosterEngineStatus): void {
  currentStatus = status
  for (const listener of listeners) listener(status)
}

function failPending(message: string): void {
  setStatus({ kind: 'failed', detail: message })
  for (const { reject } of pending.values()) {
    reject(new PosterEngineError('engine', 'POSTER_ENGINE_UNAVAILABLE', message))
  }
  pending.clear()
  // A worker that failed once cannot be trusted to answer a later request —
  // keeping it cached would strand every retry on a dead process. Terminate it
  // so the next renderPosterPng call boots a fresh one.
  worker?.terminate()
  worker = null
}

function ensureWorker(): Worker {
  worker ??= (() => {
    // `new URL(..., import.meta.url)` is the form Vite recognises for bundling a module worker.
    const spawned = new Worker(new URL('./pyodide.worker.ts', import.meta.url), { type: 'module' })
    spawned.onmessage = (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data
      if (message.type === 'status') {
        setStatus(message.status)
        return
      }
      if (message.type === 'ready') {
        engineVersion = message.version
        return
      }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok && message.png) {
        entry.resolve(message.png)
      } else {
        entry.reject(
          new PosterEngineError(
            message.kind ?? 'engine',
            message.code ?? 'POSTER_RENDER_FAILED',
            message.message ?? 'poster rendering failed',
            message.field,
          ),
        )
      }
    }
    spawned.onerror = () => failPending('poster engine worker failed')
    spawned.onmessageerror = () => failPending('poster engine worker dropped a message')
    return spawned
  })()
  return worker
}

/**
 * Render a poster spec to PNG bytes inside the Pyodide worker.
 *
 * The spec is passed to the worker as a structured clone and serialised to JSON *there* — even a
 * maximum-size spec (200k points × 4 arrays, ~8.6 MB of base64) never touches the main thread's
 * JSON machinery. Python-side `validation.validate_spec` re-validates it regardless of what the
 * TypeScript side already checked; a rejection comes back as `PosterEngineError` with
 * `kind: 'spec'`, an engine fault as `kind: 'engine'`.
 */
export function renderPosterPng(spec: PosterPlotSpec): Promise<Uint8Array> {
  const spawned = ensureWorker()
  const id = nextRequestId++
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      spawned.postMessage({ type: 'render', id, spec })
    } catch (error) {
      // postMessage throws only on a structured-clone failure or a dead worker;
      // either way the request must settle rather than hang in `pending`.
      pending.delete(id)
      reject(
        error instanceof Error
          ? error
          : new PosterEngineError('engine', 'POSTER_ENGINE_UNAVAILABLE', String(error)),
      )
    }
  })
}

export function posterEngineVersion(): string {
  return engineVersion
}

/** Subscribe to engine status; the current status is delivered synchronously on subscribe. */
export function onPosterEngineStatus(callback: (status: PosterEngineStatus) => void): () => void {
  listeners.add(callback)
  callback(currentStatus)
  return () => listeners.delete(callback)
}
