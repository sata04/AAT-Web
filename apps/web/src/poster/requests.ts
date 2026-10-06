/**
 * The poster requests the browser makes, and the rules about when it may make them.
 *
 * Two figures, two different lifecycles — and both are drawn **locally** now, by
 * the Pyodide engine in `engine/`, not by a container behind the Worker:
 *
 *  - **The automatic poster** is produced once per analysis revision, right after
 *    the snapshot is stored. It is idempotent *in the database* — a partial unique
 *    index on `(analysis_revision_id, preset_version) WHERE kind = 'auto'` — so the
 *    browser does not have to be careful, and this module does not implement a
 *    second, weaker guarantee on top of it. What it does implement is the rule that
 *    the upload is made from a *completed sync*, never from a React effect, a
 *    rerender, or the act of looking at a poster: `listPosters` and
 *    `posterImageUrl` are reads, and reading a gallery must never start a render.
 *  - **A custom poster** is produced when a researcher presses the button, and is
 *    deliberately not idempotent, because adjusting the axis bounds and rendering
 *    again is a request for a different picture. History is kept; nothing is
 *    overwritten.
 *
 * Rendering needs no account, no network and no Worker: with the cloud disabled or
 * unreachable the PNG still exists and can be downloaded — the cloud copy is an
 * optional upload of a finished local image, not the way the image comes to be.
 * Uploads happen only when `cloudEnabled()` and the revision exists; nothing else
 * ever calls the Worker.
 *
 * Every failure here is reported and then forgotten. None of it touches the local
 * analysis: by the time any of this runs, the numbers the researcher came for
 * already exist on their machine.
 */

import type { PosterPlotSpec } from '@aat/plot-spec'
import { buildAutoPosterPlotSpec, buildPosterPlotSpec, type PosterPlotSpecBuildRequest } from '@aat/plot-spec'
import type { Dataset } from '../app/dataset.ts'
import { cloudEnabled } from '../cloud/enabled.ts'
import { createCustomPoster, requestAutoPoster } from '../cloud/gateway.ts'
import type { PosterStatus } from '../cloud/status.ts'
import { onPosterEngineStatus, posterEngineVersion, renderPosterPng } from './engine/renderer.ts'
import {
  entryFromFigure,
  entryFromRender,
  entryWithFigure,
  localPosterRevisionId,
  type PosterEntry,
  pngToBase64,
  releasePosterUrl,
} from './entry.ts'
import { describePosterSpecError, type PosterSpecAdvice } from './errors.ts'
import { posterSourceFor } from './source.ts'

/**
 * The identity a poster is filed under: which revision, and which experiment it
 * belongs to.
 *
 * `revisionId` is null when the analysis was never stored — signed out, offline,
 * or a deployment with no cloud half. The poster is still drawn and downloadable;
 * its spec records `local:<runCode>` as the revision and no upload is attempted.
 */
export interface PosterContext {
  revisionId: string | null
  /** Six digits and an optional suffix letter — `spec.runCode`, and the figure's default name. */
  runCode: string
  dataset: Dataset
}

export type PosterRequestOutcome =
  /**
   * The figure rendered. `uploaded` says whether a copy now exists server-side;
   * `entry` is displayable either way (its `posterId` is set iff uploaded).
   */
  | { ok: true; entry: PosterEntry; uploaded: boolean }
  /** The spec could not be built at all. Nothing was sent, and the advice says what to change. */
  | { ok: false; kind: 'spec'; advice: PosterSpecAdvice }
  /**
   * The request failed — the draw threw, or storing the finished PNG was
   * refused / dropped. `entry` is present when the render itself succeeded, so
   * a caller can still show and download the image; only the cloud copy is
   * missing. It is null when the engine could not draw at all.
   */
  | { ok: false; kind: 'cloud'; entry: PosterEntry | null; message: string; retryable: boolean }

/** The presentation choices a custom poster carries, on top of its range and sensors. */
export type CustomPosterRequest = Omit<
  PosterPlotSpecBuildRequest,
  'analysisRevisionId' | 'runCode' | 'source'
>

/* ------------------------------------------------------------------------------------------- */
/* Building                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Build the automatic poster's spec for a revision.
 *
 * Everything in it comes from the frozen preset, the revision, or the data — no UI state, no
 * viewport, no local y-limits — so every path that derives "the automatic poster of this revision"
 * derives the same document and therefore the same `specHash`.
 */
export function buildAutoSpec(context: PosterContext): PosterPlotSpec {
  return buildAutoPosterPlotSpec({
    analysisRevisionId: context.revisionId ?? localPosterRevisionId(context.runCode),
    runCode: context.runCode,
    source: posterSourceFor(context.dataset),
  })
}

/**
 * Build a custom poster's spec from the dialog's values.
 *
 * The source is minted here rather than passed in, which is what keeps a caller from supplying
 * anything but the whole full-resolution series: `posterSourceFor` reads the dataset's branded
 * arrays, and the builder does its own windowing from them.
 */
export function buildCustomSpec(context: PosterContext, request: CustomPosterRequest): PosterPlotSpec {
  return buildPosterPlotSpec({
    ...request,
    analysisRevisionId: context.revisionId ?? localPosterRevisionId(context.runCode),
    runCode: context.runCode,
    source: posterSourceFor(context.dataset),
  })
}

/* ------------------------------------------------------------------------------------------- */
/* Rendering                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * Draw a spec locally and — only when there is a cloud to keep it — upload the
 * finished PNG.
 *
 * The lane sees the engine's own lifecycle while the draw runs (`loading` on the
 * first call, which fetches the runtime; `rendering` after that), then `uploading`
 * for the optional store, then the settled state. An abandoned request keeps
 * rendering — a drawn figure is cheap to keep — but stops writing statuses, so a
 * superseded request cannot describe a figure nobody is waiting for any more.
 */
async function renderAndMaybeStore(
  spec: PosterPlotSpec,
  kind: 'auto' | 'custom',
  context: PosterContext,
  onStatus: (status: PosterStatus) => void,
  signal: AbortSignal | undefined,
): Promise<PosterRequestOutcome> {
  const report = (status: PosterStatus) => {
    if (!isAborted(signal)) onStatus(status)
  }

  const unsubscribe = onPosterEngineStatus((engine) => {
    if (engine.kind === 'loading') report({ kind: 'loading' })
    else if (engine.kind === 'rendering') report({ kind: 'rendering' })
  })
  let png: Uint8Array
  try {
    png = await renderPosterPng(spec)
  } catch (error) {
    const message = renderFailureMessage(error)
    report({ kind: 'failed', message, retryable: true })
    return { ok: false, kind: 'cloud', entry: null, message, retryable: true }
  } finally {
    unsubscribe()
  }

  const entry = entryFromRender({
    png,
    kind,
    presetVersion: spec.posterPresetVersion,
    rendererVersion: posterEngineVersion(),
    analysisRevisionId: spec.analysisRevisionId,
  })

  if (!shouldUpload(context)) {
    report({ kind: 'ready', url: entry.imageUrl })
    return { ok: true, entry, uploaded: false }
  }

  report({ kind: 'uploading' })
  const stored =
    kind === 'auto'
      ? await requestAutoPoster(context.revisionId as string, spec, pngToBase64(png), posterEngineVersion())
      : await createCustomPoster(context.revisionId as string, spec, pngToBase64(png), posterEngineVersion())

  if (!stored.ok) {
    const retryable = stored.kind === 'unavailable' || stored.retryable
    // The image exists; only its cloud copy is missing — so the failure is
    // reported with the entry still usable.
    report({ kind: 'failed', message: stored.message, retryable })
    return { ok: false, kind: 'cloud', entry, message: stored.message, retryable }
  }

  const figure = stored.value.poster
  // `created` exists only on the auto endpoint's response shape; a custom upload always made its row.
  const created = 'created' in stored.value ? stored.value.created : undefined
  if (created === false) {
    // The slot already held this revision's figure — rendered by a different
    // engine build, so it is a *different image* from the bytes just drawn.
    // The stored row is the canonical one: show it (remote URL, no local copy)
    // and release the local render, which was never displayed anywhere.
    releasePosterUrl(entry.imageUrl)
    const storedEntry = entryFromFigure(figure)
    report({ kind: 'ready', url: storedEntry.imageUrl, posterId: figure.posterId })
    return { ok: true, entry: storedEntry, uploaded: true }
  }
  const storedEntry = entryWithFigure(entry, figure)
  report({ kind: 'ready', url: storedEntry.imageUrl, posterId: figure.posterId })
  return { ok: true, entry: storedEntry, uploaded: true }
}

/** Whether this context's render gets a cloud copy. */
function shouldUpload(context: PosterContext): boolean {
  return cloudEnabled() && context.revisionId !== null
}

/**
 * Ask for the automatic poster.
 *
 * Safe to call again after a dropped connection or a reload: rendering again is
 * local work, and the upload endpoint claims the figure with
 * `INSERT ... ON CONFLICT DO NOTHING`, so a repeat stores nothing twice —
 * including after a previous upload already succeeded, when it answers the
 * existing row with `created: false`.
 */
export async function generateAutoPoster(
  context: PosterContext,
  onStatus: (status: PosterStatus) => void,
  signal?: AbortSignal,
): Promise<PosterRequestOutcome> {
  let spec: PosterPlotSpec
  try {
    spec = buildAutoSpec(context)
  } catch (error) {
    return { ok: false, kind: 'spec', advice: describePosterSpecError(error) }
  }
  return renderAndMaybeStore(spec, 'auto', context, onStatus, signal)
}

/**
 * Render a custom poster from the dialog's values.
 *
 * `onStatus` is optional here because a custom figure is not one of the three status lanes: it is
 * a thing the researcher asked for and is waiting on, shown in the dialog that asked.
 */
export async function generateCustomPoster(
  context: PosterContext,
  request: CustomPosterRequest,
  onStatus: (status: PosterStatus) => void = () => {},
  signal?: AbortSignal,
): Promise<PosterRequestOutcome> {
  let spec: PosterPlotSpec
  try {
    spec = buildCustomSpec(context, request)
  } catch (error) {
    return { ok: false, kind: 'spec', advice: describePosterSpecError(error) }
  }
  return renderAndMaybeStore(spec, 'custom', context, onStatus, signal)
}

/* ------------------------------------------------------------------------------------------- */
/* Statuses                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Read the signal through a call rather than inline.
 *
 * `AbortSignal.aborted` is a readonly property, so the compiler narrows it to `false` after a
 * check and then reports the *next* check — the one after an await, which is the only one that can
 * observe a change — as unreachable. A function boundary keeps the question honest.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Why a local render threw, in Japanese.
 *
 * The engine's own message is useful in a log and in a support question, and not
 * something to put in front of a researcher on its own — it is appended in
 * brackets, and the sentence stands without it.
 */
function renderFailureMessage(error: unknown): string {
  const base = 'ポスターの生成に失敗しました。'
  const detail = error instanceof Error ? error.message : String(error)
  return detail.length === 0 ? base : `${base}（${detail}）`
}
