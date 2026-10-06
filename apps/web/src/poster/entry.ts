/**
 * The poster figure as the UI sees it.
 *
 * Two sources produce the same shape: a `PosterFigure` row returned by the
 * Worker (its PNG lives at `imageUrl`), and a render the local engine just
 * produced (its PNG is in `png`, `posterId` is null until an upload assigns
 * one). Keeping one type lets panels and dialogs show both without caring
 * whether the cloud is reachable — or enabled at all.
 */
import { type PosterFigure, posterImageUrl } from '../cloud/gateway'

/**
 * `spec.analysisRevisionId` for a poster the cloud will never see.
 *
 * Scoped by the run code rather than one shared literal: two different unsigned-in
 * experiments must not share a history bucket, and the run code is the experiment's
 * own identity — the same key the cloud side files runs under.
 */
export function localPosterRevisionId(runCode: string): string {
  return `local:${runCode}`
}

export interface PosterEntry {
  /** Server id, once this render is stored there; null for a local-only figure. */
  posterId: string | null
  /** The revision the figure was stored under, or `local:<runCode>` when it never left the machine. */
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
 *
 * `imageUrl` deliberately stays the *local* one — and this is only sound because the
 * caller reaches this function exclusively when the upload *created* the row: the
 * stored figure then holds these very bytes, so the preview and the id describe
 * the same image. An idempotent `created: false` answer names a figure someone
 * else rendered (possibly under a different engine build) — for that, see
 * {@link entryFromFigure}, which shows the stored image rather than this one.
 */
export function entryWithFigure(entry: PosterEntry, figure: PosterFigure): PosterEntry {
  return { ...entry, posterId: figure.posterId, figure }
}

/**
 * Wrap a figure the server already held.
 *
 * The stored row is the canonical image — the API URL, not a locally rendered
 * copy that may differ byte-for-byte under another engine build. `png` is null
 * for exactly the reason `imageUrl` is the remote one: the bytes here are the
 * figure's, not the client's.
 */
export function entryFromFigure(figure: PosterFigure): PosterEntry {
  return {
    posterId: figure.posterId,
    analysisRevisionId: figure.analysisRevisionId,
    kind: figure.kind,
    presetVersion: figure.presetVersion,
    createdAt: figure.createdAt,
    imageUrl: posterImageUrl(figure.posterId),
    png: null,
    status: figure.status,
    rendererVersion: figure.rendererVersion,
    failureCode: figure.failureCode,
    figure,
  }
}

/**
 * Blob URLs minted by {@link pngToDisplayUrl}, still potentially displayed.
 *
 * Per-entry revocation is deliberately rare: the panel and the status lane can
 * hold the same URL, so revoking on one drop would blank the other. It happens
 * only for URLs proven never-displayed ({@link releasePosterUrl}); the rest are
 * released wholesale at screen unmount, when nothing can still be showing them.
 */
const liveDisplayUrls = new Set<string>()
/**
 * False once the Analyzer screen has unmounted: a render that completes late mints a URL
 * nobody can display, so new mints are revoked on the spot rather than parked in the set.
 * Reopened by the next mount.
 */
let registryOpen = true

/** Reopen the registry — called from the Analyzer screen's mount effect. */
export function openPosterUrlRegistry(): void {
  registryOpen = true
}

/** Revoke one URL minted by {@link pngToDisplayUrl} — e.g. a render that was never displayed. */
export function releasePosterUrl(url: string): void {
  liveDisplayUrls.delete(url)
  globalThis.URL?.revokeObjectURL?.(url)
}

/** Revoke every live blob URL — called from the Analyzer screen's unmount. */
export function releasePosterUrls(): void {
  for (const url of liveDisplayUrls) globalThis.URL?.revokeObjectURL?.(url)
  liveDisplayUrls.clear()
  registryOpen = false
}

export function pngToDisplayUrl(png: Uint8Array): string {
  const URL_ = globalThis.URL
  if (typeof URL_?.createObjectURL === 'function') {
    const url = URL_.createObjectURL(new Blob([png as BlobPart], { type: 'image/png' }))
    if (registryOpen) liveDisplayUrls.add(url)
    else URL_.revokeObjectURL(url)
    return url
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
