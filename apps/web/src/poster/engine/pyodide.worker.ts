/**
 * The poster engine's Web Worker.
 *
 * Laziness is the contract here: this worker is spawned by `renderer.ts` only when the first
 * poster is actually requested, and inside it Pyodide + matplotlib (~26 MiB of vendored WASM and
 * wheels) load only then — opening the app costs nothing. Every file it fetches is same-origin
 * under `/pyodide/<version>/` (see `scripts/vendor-poster-assets.mjs`), which is what lets the
 * whole path work inside `connect-src 'self'` and offline under the service worker.
 *
 * Message protocol (in):
 *   `{type: 'render', id, spec}` — a `PosterPlotSpec` object, structured-cloned.
 *
 * Message protocol (out):
 *   `{type: 'status', status}`              — every engine status change, as it happens.
 *   `{type: 'ready', version}`              — once, after boot, with the full engine version.
 *   `{type: 'rendered', id, ok: true, png}` — PNG bytes (transferred, not copied).
 *   `{type: 'rendered', id, ok: false, kind, code, message, field?}` — PosterEngineError fields.
 */

/// <reference lib="webworker" />

import pyodidePackage from 'pyodide/package.json'

import {
  bootPosterEngine,
  PosterEngineError,
  type PosterEngineHost,
  type PosterEngineStatus,
} from './engine-core.ts'

const scope = self as unknown as DedicatedWorkerGlobalScope

interface RenderRequest {
  type: 'render'
  id: number
  spec: unknown
}

interface StatusMessage {
  type: 'status'
  status: PosterEngineStatus
}

interface ReadyMessage {
  type: 'ready'
  version: string
}

interface RenderedMessage {
  type: 'rendered'
  id: number
  ok: boolean
  png?: Uint8Array
  kind?: 'spec' | 'engine'
  code?: string
  message?: string
  field?: string | undefined
}

let hostPromise: Promise<PosterEngineHost> | null = null
let bootError: PosterEngineError | null = null

const postStatus = (status: PosterEngineStatus) => {
  const message: StatusMessage = { type: 'status', status }
  scope.postMessage(message)
}

function boot(): Promise<PosterEngineHost> {
  if (bootError) return Promise.reject(bootError)
  hostPromise ??= bootPosterEngine({
    // Vendored at build/dev time under /pyodide/<version>/ — versioned so the URL is immutable
    // and the service worker can treat it as cache-first-forever.
    indexURL: `/pyodide/${pyodidePackage.version}/`,
    onStatus: postStatus,
  }).then((host) => {
    const v = host.versions()
    const message: ReadyMessage = {
      type: 'ready',
      version: `pyodide-${pyodidePackage.version}/matplotlib-${v.matplotlib}/numpy-${v.numpy}/pillow-${v.pillow}`,
    }
    scope.postMessage(message)
    return host
  })
  // If boot rejects, every later render fails fast with UNAVAILABLE rather than retrying a
  // 26 MiB download+instantiate that already proved broken in this worker's lifetime.
  hostPromise.catch((error: unknown) => {
    bootError = new PosterEngineError(
      'engine',
      'POSTER_ENGINE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
    )
  })
  return hostPromise
}

scope.onmessage = (event: MessageEvent<RenderRequest>) => {
  const request = event.data
  if (request.type !== 'render') return

  const reply = (message: RenderedMessage) => {
    if (message.png) {
      scope.postMessage(message, [message.png.buffer])
    } else {
      scope.postMessage(message)
    }
  }

  boot()
    .then((host) => host.renderSpecJson(JSON.stringify(request.spec)))
    .then((png) => reply({ type: 'rendered', id: request.id, ok: true, png }))
    .catch((error: unknown) => {
      const engineError =
        error instanceof PosterEngineError
          ? error
          : new PosterEngineError(
              'engine',
              'POSTER_RENDER_FAILED',
              error instanceof Error ? error.message : String(error),
            )
      reply({
        type: 'rendered',
        id: request.id,
        ok: false,
        kind: engineError.kind,
        code: engineError.code,
        message: engineError.message,
        field: engineError.field,
      })
    })
}
