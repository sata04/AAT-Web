/**
 * Environment-agnostic host for the Pyodide poster engine.
 *
 * This is the part of the engine that actually talks to Pyodide, and it deliberately knows
 * nothing about DOM Workers: `pyodide.worker.ts` wraps it for the browser, and the vitest
 * suite boots it directly in Node (Pyodide supports both, which is what makes the engine
 * testable at all).
 *
 * Booting is lazy and happens once per context. Rendering is serialised: Pyodide is a single
 * interpreter, so concurrent renders queue instead of interleaving inside it.
 */

import { loadPyodide, type PyodideAPI } from 'pyodide'
import type { PyProxy } from 'pyodide/ffi'

import { POSTER_PYTHON_SOURCES } from './python-sources.ts'

/** Engine lifecycle states the UI can surface; 'loading' → 'ready' happens exactly once. */
export interface PosterEngineStatus {
  kind: 'idle' | 'loading' | 'ready' | 'rendering' | 'failed'
  /** Free-text detail for progress display ("loading matplotlib", ...). */
  detail?: string | undefined
}

/**
 * Why a render failed. `'spec'` maps to the caller-side spec-advice surface
 * (`src/poster/errors.ts`'s PosterSpecAdvice); `'engine'` maps to POSTER_RENDER_FAILED.
 */
export type PosterEngineErrorKind = 'spec' | 'engine'

export class PosterEngineError extends Error {
  readonly kind: PosterEngineErrorKind
  /** Machine code (`POSTER_SPEC_INVALID`, `POSTER_RENDER_FAILED`, `POSTER_ENGINE_UNAVAILABLE`). */
  readonly code: string
  /** Dotted spec path when the rejection named a field; never the rejected value. */
  readonly field?: string | undefined

  constructor(kind: PosterEngineErrorKind, code: string, message: string, field?: string) {
    super(message)
    this.name = 'PosterEngineError'
    this.kind = kind
    this.code = code
    this.field = field
  }
}

export interface PosterEngineVersions {
  readonly matplotlib: string
  readonly numpy: string
  readonly pillow: string
  /** `poster_renderer.version.RENDERER_VERSION`, e.g. "aat-poster-renderer/1.2.0". */
  readonly renderer: string
}

export interface PosterEngineHost {
  /** Validate + render a spec JSON document; PNG bytes out. Never throws raw Python errors. */
  renderSpecJson(raw: string): Promise<Uint8Array>
  /** Versions measured inside the interpreter at boot. */
  versions(): PosterEngineVersions
}

interface RenderResult {
  ok: boolean
  png?: Uint8Array
  kind?: 'spec' | 'render'
  code?: string
  message?: string
  field?: string
}

/** A PyProxy standing in for a Python function — callable, result must be converted + freed. */
type PyCallable = ((arg: string) => PyProxy) | (() => PyProxy)

const PYTHON_SOURCE_ROOT = '/poster-src'

export async function bootPosterEngine(options: {
  /** Directory (URL or filesystem path) holding the vendored pyodide core + wheels. */
  indexURL: string
  onStatus?: (status: PosterEngineStatus) => void
}): Promise<PosterEngineHost> {
  const report = (status: PosterEngineStatus) => options.onStatus?.(status)

  let pyodide: PyodideAPI
  let renderSpecJson: PyCallable
  let versions: PosterEngineVersions
  try {
    report({ kind: 'loading', detail: 'pyodide core' })
    pyodide = await loadPyodide({
      indexURL: options.indexURL,
      // Wheels live next to the core files — never the CDN (connect-src 'self').
      packageBaseUrl: options.indexURL,
    })

    report({ kind: 'loading', detail: 'matplotlib, numpy, pillow' })
    await pyodide.loadPackage(['matplotlib', 'numpy', 'pillow'])

    report({ kind: 'loading', detail: 'poster sources' })
    for (const file of POSTER_PYTHON_SOURCES) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''
      if (dir) pyodide.FS.mkdirTree(`${PYTHON_SOURCE_ROOT}/${dir}`)
      pyodide.FS.writeFile(`${PYTHON_SOURCE_ROOT}/${file.path}`, file.source)
    }
    pyodide.runPython(
      `import sys\nsys.path.insert(0, ${JSON.stringify(PYTHON_SOURCE_ROOT)})\n` +
        'from engine_entry import engine_versions, render_spec_json',
    )

    const versionsProxy = pyodide.globals.get('engine_versions')() as PyProxy
    try {
      versions = versionsProxy.toJs({ dict_converter: Object.fromEntries }) as PosterEngineVersions
    } finally {
      versionsProxy.destroy()
    }
    renderSpecJson = pyodide.globals.get('render_spec_json') as unknown as PyCallable
  } catch (error) {
    report({ kind: 'failed', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }

  // Renders serialise through this tail so two callers can never interleave inside one
  // interpreter. A rejected render must not break the queue, hence the absorb-and-continue.
  let tail: Promise<unknown> = Promise.resolve()

  const host: PosterEngineHost = {
    renderSpecJson(raw: string): Promise<Uint8Array> {
      const job = tail.then(async () => {
        report({ kind: 'rendering' })
        try {
          const proxy = (renderSpecJson as (arg: string) => PyProxy)(raw)
          let result: RenderResult
          try {
            result = proxy.toJs({ dict_converter: Object.fromEntries }) as RenderResult
          } finally {
            proxy.destroy()
          }
          if (result.ok && result.png) {
            return result.png
          }
          // A spec rejection is a caller fault and the engine stays healthy; a render failure is
          // an engine fault. Both surface as PosterEngineError — the kind is what errors.ts keys
          // off to pick the advice path.
          throw new PosterEngineError(
            result.kind === 'spec' ? 'spec' : 'engine',
            result.code ?? 'POSTER_RENDER_FAILED',
            result.message ?? 'poster rendering failed',
            result.field,
          )
        } finally {
          report({ kind: 'ready' })
        }
      })
      tail = job.then(
        () => undefined,
        () => undefined,
      )
      return job
    },

    versions(): PosterEngineVersions {
      return versions
    },
  }

  report({ kind: 'ready' })
  return host
}
