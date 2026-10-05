/**
 * The poster figure as the UI sees it.
 *
 * Two sources produce the same shape: a `PosterFigure` row returned by the
 * Worker (its PNG lives at `imageUrl`), and a render the local engine just
 * produced (its PNG is in `png`, `posterId` is null until an upload assigns
 * one). Keeping one type lets panels and dialogs show both without caring
 * whether the cloud is reachable — or enabled at all.
 */
import type { PosterFigure } from '../cloud/gateway'

export interface PosterEntry {
  /** Server id, once this render is stored there; null for a local-only figure. */
  posterId: string | null
  /** The revision the figure was stored under, or 'local' when it never left the machine. */
  analysisRevisionId: string
  kind: 'auto' | 'custom'
  presetVersion: string
  createdAt: string
  /** Displayable image address — a server URL or an object/data URL for `png`. */
  imageUrl: string
  /** The rendered bytes when produced locally; null for figures only known to the server. */
  png: Uint8Array | null
  status: 'queued' | 'rendering' | 'ready' | 'failed'
  /** Null when the storing row does not know which engine produced the figure. */
  rendererVersion: string | null
  failureCode: string | null
  /** The authoritative row, when this entry came from the Worker. */
  figure?: PosterFigure
}

/**
 * Wrap freshly rendered PNG bytes.
 * Prefers a blob URL; tests running under jsdom (no `URL.createObjectURL`)
 * get a data URL instead, so both environments can display the image.
 */
export function entryFromRender(input: {
  png: Uint8Array
  kind: 'auto' | 'custom'
  presetVersion: string
  rendererVersion: string
  analysisRevisionId: string
}): PosterEntry {
  return {
    posterId: null,
    analysisRevisionId: input.analysisRevisionId,
    kind: input.kind,
    presetVersion: input.presetVersion,
    createdAt: new Date().toISOString(),
    imageUrl: pngToDisplayUrl(input.png),
    png: input.png,
    status: 'ready',
    rendererVersion: input.rendererVersion,
    failureCode: null,
  }
}

/**
 * Copy `figure`'s identity onto an entry rendered locally, after the bytes
 * were uploaded and the Worker assigned the canonical row.
 */
export function entryWithFigure(entry: PosterEntry, figure: PosterFigure, imageUrl: string): PosterEntry {
  return { ...entry, posterId: figure.posterId, figure, imageUrl }
}

export function pngToDisplayUrl(png: Uint8Array): string {
  const URL_ = globalThis.URL
  if (typeof URL_?.createObjectURL === 'function') {
    return URL_.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
  }
  return `data:image/png;base64,${pngToBase64(png)}`
}

/** `btoa` on large binaries; chunked because spread-on-apply overflows its argument limit. */
export function pngToBase64(png: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < png.length; i += CHUNK) {
    binary += String.fromCharCode(...png.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
