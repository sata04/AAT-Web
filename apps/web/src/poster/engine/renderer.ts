/**
 * The local poster renderer — placeholder.
 *
 * The real implementation renders `spec` with Matplotlib running on Pyodide
 * (WASM CPython) inside the browser. This stub exists so the request/UI wiring
 * is exercisable before it lands; it emits the engine's status sequence and
 * returns a tiny valid PNG instead of a figure. Everything outside this file
 * consumes only the contract below, so replacing the file replaces the engine.
 */
import type { PosterPlotSpec } from '@aat/plot-spec'

/**
 * Engine lifecycle, watched by the request layer for status display.
 * `loading` is the first-run runtime fetch (tens of MB); `rendering` is an
 * actual draw; `ready`/`idle` are the quiet states between them.
 */
export interface PosterEngineStatus {
  kind: 'idle' | 'loading' | 'ready' | 'rendering' | 'failed'
  detail?: string
}

type Listener = (status: PosterEngineStatus) => void

const listeners = new Set<Listener>()
let current: PosterEngineStatus = { kind: 'idle' }

function emit(status: PosterEngineStatus): void {
  current = status
  for (const listener of listeners) listener(status)
}

/** Subscribe to engine status changes; returns the unsubscribe. */
export function onPosterEngineStatus(callback: Listener): () => void {
  listeners.add(callback)
  callback(current)
  return () => listeners.delete(callback)
}

/** Version stamped onto figures this engine produced. */
export function posterEngineVersion(): string {
  return 'aat-poster-engine/pyodide-stub'
}

/** A valid 1×1 PNG, standing in for a rendered figure until the real engine lands. */
const STUB_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00,
  0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xfc, 0xcf, 0xc0, 0x50, 0x0f, 0x00, 0x04, 0x85, 0x01, 0x80,
  0x84, 0xa9, 0x8c, 0x21, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function renderPosterPng(_spec: PosterPlotSpec): Promise<Uint8Array> {
  emit({ kind: 'loading', detail: 'placeholder engine' })
  await delay(150)
  emit({ kind: 'rendering' })
  await delay(150)
  emit({ kind: 'ready' })
  return STUB_PNG
}
