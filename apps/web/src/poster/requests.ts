/**
 * The poster requests the browser makes, and the rules about when it may make them.
 *
 * Two figures, two completely different lifecycles:
 *
 *  - **The automatic poster** is asked for exactly once per analysis revision, right after the
 *    snapshot is stored. It is idempotent *in the database* — a partial unique index on
 *    `(analysis_revision_id, preset_version) WHERE kind = 'auto'` — so the browser does not have to
 *    be careful, and this module does not implement a second, weaker guarantee on top of it. What
 *    it does implement is the rule that the endpoint is called from a *completed sync*, never from
 *    a React effect, a rerender, or the act of looking at a poster: `listPosters` and
 *    `posterImageUrl` are reads, and reading a gallery must never start a render.
 *  - **A custom poster** is asked for when a researcher presses the button, and is deliberately not
 *    idempotent, because adjusting the axis bounds and rendering again is a request for a different
 *    picture. History is kept; nothing is overwritten.
 *
 * Both settle the same way. The Worker renders inline and normally answers with the finished
 * figure, but it may also hand back one that another tab is already rendering, so anything not yet
 * `ready` or `failed` is polled through `GET /revisions/:id/posters` — a listing, which renders
 * nothing — until it settles or the deadline passes.
 *
 * Every failure here is reported and then forgotten. None of it touches the local analysis: by the
 * time any of this runs, the numbers the researcher came for already exist on their machine.
 */

import type { PosterPlotSpec } from '@aat/plot-spec'
import { buildAutoPosterPlotSpec, buildPosterPlotSpec, type PosterPlotSpecBuildRequest } from '@aat/plot-spec'
import type { Dataset } from '../app/dataset.ts'
import {
  type CloudOutcome,
  createCustomPoster,
  listPosters,
  type PosterFigure,
  posterImageUrl,
  requestAutoPoster,
  retryPoster,
} from '../cloud/gateway.ts'
import type { PosterStatus } from '../cloud/status.ts'
import { describePosterSpecError, type PosterSpecAdvice } from './errors.ts'
import { posterSourceFor } from './source.ts'

/** How often a figure that is still rendering is re-read. */
const POLL_INTERVAL_MS = 2_500

/**
 * How long to keep polling before giving up.
 *
 * A cold Python + Matplotlib container takes seconds to start and the Worker's own render deadline
 * is 60 s, so two minutes covers a cold start plus a render with room to spare. Past that, saying
 * "it did not finish, try again" is more honest than a lane that says 生成中 forever.
 */
const POLL_DEADLINE_MS = 120_000

/** The identity a poster is filed under: which revision, and which experiment it belongs to. */
export interface PosterContext {
  revisionId: string
  /** Six digits and an optional suffix letter — `spec.runCode`, and the figure's default name. */
  runCode: string
  dataset: Dataset
}

export type PosterRequestOutcome =
  | { ok: true; poster: PosterFigure }
  /** The spec could not be built at all. Nothing was sent, and the advice says what to change. */
  | { ok: false; kind: 'spec'; advice: PosterSpecAdvice }
  /** The request was made and refused, or the render did not finish. */
  | { ok: false; kind: 'cloud'; message: string; retryable: boolean }

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
    analysisRevisionId: context.revisionId,
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
    analysisRevisionId: context.revisionId,
    runCode: context.runCode,
    source: posterSourceFor(context.dataset),
  })
}

/* ------------------------------------------------------------------------------------------- */
/* Requesting                                                                                   */
/* ------------------------------------------------------------------------------------------- */

/**
 * Ask for the automatic poster.
 *
 * Safe to call again after a dropped connection or a reload: the endpoint claims the figure with
 * `INSERT ... ON CONFLICT DO NOTHING`, so a repeat call reads back the existing row and renders
 * nothing — including when that row has already failed, which is why a failure is retried through
 * {@link retryAutoPoster} and not by calling this again.
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
  onStatus({ kind: 'queued' })
  return settleRequest(context, requestAutoPoster(context.revisionId, spec), onStatus, signal)
}

/**
 * Retry the automatic poster.
 *
 * A figure that reached `failed` is re-attempted through the retry endpoint, which is conditional
 * on it still being failed or queued — so pressing the button five times starts one render. A
 * figure we never got an id for (the request itself was refused, or the renderer shed load) is
 * retried by calling the idempotent endpoint again, which picks up the queued row.
 */
export async function retryAutoPoster(
  context: PosterContext,
  posterId: string | null,
  onStatus: (status: PosterStatus) => void,
  signal?: AbortSignal,
): Promise<PosterRequestOutcome> {
  if (posterId === null) return generateAutoPoster(context, onStatus, signal)

  let spec: PosterPlotSpec
  try {
    spec = buildAutoSpec(context)
  } catch (error) {
    return { ok: false, kind: 'spec', advice: describePosterSpecError(error) }
  }
  onStatus({ kind: 'queued', posterId })
  return settleRequest(context, retryPoster(posterId, spec), onStatus, signal)
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
  onStatus({ kind: 'queued' })
  return settleRequest(context, createCustomPoster(context.revisionId, spec), onStatus, signal)
}

/* ------------------------------------------------------------------------------------------- */
/* Settling                                                                                     */
/* ------------------------------------------------------------------------------------------- */

async function settleRequest(
  context: PosterContext,
  pending: Promise<CloudOutcome<{ poster: PosterFigure }>>,
  onStatus: (status: PosterStatus) => void,
  signal: AbortSignal | undefined,
): Promise<PosterRequestOutcome> {
  // An abandoned request must not keep writing to the lane. A newer request aborts the older one
  // and immediately reports `queued`; without this guard the older one's next update would land
  // afterwards and describe a figure nobody is waiting for any more.
  const report = (status: PosterStatus) => {
    if (!isAborted(signal)) onStatus(status)
  }

  const outcome = await pending
  if (!outcome.ok) {
    const failure = {
      ok: false as const,
      kind: 'cloud' as const,
      message: outcome.message,
      // An unreachable cloud is almost always a network that came back; the taxonomy decides for
      // everything else, and `POSTER_BUSY` is backpressure rather than a fault.
      retryable: outcome.kind === 'unavailable' || outcome.retryable,
    }
    report({ kind: 'failed', message: failure.message, retryable: failure.retryable })
    return failure
  }

  const figure = await pollUntilSettled(context.revisionId, outcome.value.poster, report, signal)
  report(statusFor(figure))

  if (figure.status === 'ready') return { ok: true, poster: figure }
  if (figure.status === 'failed') {
    return { ok: false, kind: 'cloud', message: failureMessage(figure), retryable: true }
  }
  return {
    ok: false,
    kind: 'cloud',
    message: 'ポスターの生成が時間内に終わりませんでした。しばらくしてから再試行してください。',
    retryable: true,
  }
}

/**
 * Re-read a figure until it is `ready` or `failed`.
 *
 * The listing endpoint is a plain read: it renders nothing, it starts nothing, and it is the only
 * way to observe a figure another request is drawing. A transient listing failure is not fatal —
 * the previous state is kept and the next tick tries again — because a poll that gives up on one
 * dropped response would report a failure the renderer never had.
 */
async function pollUntilSettled(
  revisionId: string,
  initial: PosterFigure,
  onStatus: (status: PosterStatus) => void,
  signal: AbortSignal | undefined,
): Promise<PosterFigure> {
  let current = initial
  const deadline = Date.now() + POLL_DEADLINE_MS

  while (current.status !== 'ready' && current.status !== 'failed') {
    if (isAborted(signal) || Date.now() >= deadline) return current
    onStatus(statusFor(current))
    await delay(POLL_INTERVAL_MS, signal)
    if (isAborted(signal)) return current

    const listed = await listPosters(revisionId)
    if (!listed.ok) continue
    const found = listed.value.posters.find((poster) => poster.posterId === current.posterId)
    if (found !== undefined) current = found
  }
  return current
}

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

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The three-lane status a figure corresponds to. */
export function statusFor(figure: PosterFigure): PosterStatus {
  switch (figure.status) {
    case 'ready':
      return { kind: 'ready', url: posterImageUrl(figure.posterId), posterId: figure.posterId }
    case 'failed':
      return {
        kind: 'failed',
        message: failureMessage(figure),
        retryable: true,
        posterId: figure.posterId,
      }
    case 'rendering':
      return { kind: 'rendering', posterId: figure.posterId }
    default:
      return { kind: 'queued', posterId: figure.posterId }
  }
}

/**
 * Why a figure failed, in Japanese.
 *
 * `failureCode` is the renderer's internal vocabulary — useful in a log and in the row, and not
 * something to put in front of a researcher on its own. It is appended in brackets so a support
 * question can quote it, and the sentence stands without it.
 */
function failureMessage(figure: PosterFigure): string {
  const base = 'ポスターの生成に失敗しました。'
  return figure.failureCode === null ? base : `${base}（${figure.failureCode}）`
}
