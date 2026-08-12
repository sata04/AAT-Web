/**
 * Building a poster plot spec from an analysis, which is the browser's half of the contract
 * `spec.ts` describes.
 *
 * The Worker has validated submitted specs against `PosterPlotSpecSchema` since the poster routes
 * were written; what did not exist was any supported way for the browser to *produce* one. Left to
 * itself, a "poster from the selected range" screen would have assembled the document by hand —
 * reaching for whichever arrays were nearest, which on a graph screen are the decimated ones — and
 * the resulting figure would have been wrong in a way that no test and no reviewer would have
 * caught, because it renders beautifully. This module is the alternative: one function, taking the
 * whole series and the user's choices, returning a validated spec or refusing with a code the UI
 * can render.
 *
 * **Full resolution is structural here, not advisory.** The builder accepts only a branded
 * {@link FullResolutionSeries} (see `source.ts` for the three mechanisms), it performs the x-range
 * slicing itself so no pre-sliced or pre-thinned array has a way in, it exposes no stride, budget
 * or target-width parameter that could ask for fewer points than the range holds, and a selection
 * over `MAX_POINTS` is refused with a suggested narrower span rather than quietly decimated. A
 * spec that came out of this builder therefore carries every sample the analysis engine produced
 * between `xMin` and `xMax`, or it does not exist.
 *
 * Everything the builder refuses, it refuses *before* assembling a document, with a
 * {@link PosterSpecError} — see `errors.ts` for why a `ZodError` is the wrong thing to show a
 * researcher.
 */

import { expectedBase64Length } from './codec.ts'
import { PosterSpecError } from './errors.ts'
import {
  DEFAULT_POSTER_PRESET_VERSION,
  getPosterPreset,
  isPosterPresetVersion,
  type PosterPresetVersion,
} from './presets.ts'
import { type FullResolutionSeries, isFullResolutionSeries } from './source.ts'
import type { PosterKind, PosterPlotSpec, PosterSeriesData, SeriesSelection } from './spec.ts'
import { MAX_PAYLOAD_BYTES, MAX_POINTS, safeParsePosterPlotSpec } from './spec.ts'
import { encodeSeries } from './wire.ts'

type SensorKey = 'inner' | 'drag'

/**
 * The full-resolution series available to draw from, keyed by sensor.
 *
 * Supplying a sensor here is not the same as asking for it: `series` decides what the poster
 * draws, and any sensor not implied by that selection is ignored (and its data left out of the
 * request entirely, as the schema requires). That asymmetry is deliberate — a UI can hand over
 * whatever the dataset has and let the user's radio button decide, without having to assemble a
 * different object per choice.
 */
export interface PosterSpecSource {
  readonly inner?: FullResolutionSeries
  readonly drag?: FullResolutionSeries
}

/**
 * A custom poster request: an analysis, a range, a sensor selection, and the bounded presentation
 * choices the form in `poster-form.ts` offers.
 *
 * Only `xMin`/`xMax`, the identifiers, the series selection and the source data are required.
 * Every presentation field falls back to the frozen preset, so the *simplest possible* custom
 * poster — "this range, both sensors, everything else as usual" — is byte-identical in style to
 * the automatic one, and differs from it only in the range it covers.
 */
export interface PosterPlotSpecBuildRequest {
  /** Opaque id of the analysis revision this figure is drawn from; must match the route it is posted to. */
  readonly analysisRevisionId: string
  /** Six digits and an optional lowercase suffix — the run this poster belongs to. */
  readonly runCode: string
  /** Which sensor traces to draw. The matching entries of `source` must be present. */
  readonly series: SeriesSelection
  readonly source: PosterSpecSource
  /** Seconds. The x-axis limits of the figure, and the window the samples are taken from. */
  readonly xMin: number
  readonly xMax: number
  /** Gravity level (G). Omit both to let Matplotlib autoscale the y-axis, as the preset intends. */
  readonly yMin?: number
  readonly yMax?: number
  /**
   * Overrides the *name* the renderer substitutes into the frozen title and legend templates —
   * it does not replace the title. See `posterDisplayName` in `poster-form.ts`; an empty string
   * (the default) means "use the run code", which is what the desktop application does.
   */
  readonly title?: string
  readonly showLegend?: boolean
  readonly figureWidth?: number
  readonly figureHeight?: number
  readonly dpi?: number
  readonly posterPresetVersion?: PosterPresetVersion
}

/**
 * An automatic poster request.
 *
 * Deliberately has no presentation fields at all. The automatic poster's identity is
 * `(analysisRevisionId, posterPresetVersion)` — that pair is the idempotency key the Worker
 * enforces with a partial unique index, so at most one automatic poster can ever exist per
 * revision per preset. If this helper took a range, a figure size or a y-limit, two clients could
 * derive two different "the" automatic posters for the same key and only the first would ever be
 * stored; the second client's choices would be silently discarded while its request appeared to
 * succeed. Removing the knobs removes that failure: the automatic poster is defined entirely by
 * the frozen preset plus the revision's own data, so every path that derives it — the browser
 * today, a server-side or scheduled path later — derives the same bytes.
 */
export interface AutoPosterPlotSpecBuildRequest {
  readonly analysisRevisionId: string
  readonly runCode: string
  readonly source: PosterSpecSource
  readonly posterPresetVersion?: PosterPresetVersion
}

/** One sensor's samples inside the requested window, copied out of the source arrays. */
interface SelectedWindow {
  time: Float64Array
  values: Float64Array
  /** How many of `values` are real measurements rather than NaN gaps. */
  finiteCount: number
}

/**
 * Copy the samples of `series` whose time lies in `[xMin, xMax]`, inclusive of both bounds.
 *
 * A linear scan rather than a binary search, because AAT only *warns* about a non-monotonic time
 * axis instead of rejecting it (see `decimate.ts`, which makes the same allowance for drawing). A
 * binary search would silently return the wrong window for such a recording; a scan returns
 * exactly "every sample whose instant falls inside the range", which is the honest answer for any
 * ordering and is what the desktop draws. The cost is one pass over the full series per sensor for
 * a figure a human explicitly asked for — microseconds per million samples.
 *
 * Non-finite instants need no special case: `NaN >= xMin` is false and both infinities fall
 * outside any finite range, so a spoiled time sample is excluded by the comparison itself rather
 * than by a check that could be forgotten. That is also why the resulting `time` array always
 * satisfies the schema's "time must be finite" rule by construction.
 */
function selectWindow(
  sensor: SensorKey,
  series: FullResolutionSeries,
  xMin: number,
  xMax: number,
): SelectedWindow {
  const { time, values } = series
  const length = series.length

  let count = 0
  let dataMinTime = Number.POSITIVE_INFINITY
  let dataMaxTime = Number.NEGATIVE_INFINITY
  for (let index = 0; index < length; index++) {
    const instant = time[index] as number
    if (!Number.isFinite(instant)) continue
    if (instant < dataMinTime) dataMinTime = instant
    if (instant > dataMaxTime) dataMaxTime = instant
    if (instant >= xMin && instant <= xMax) count++
  }

  if (count === 0) {
    throw new PosterSpecError('POSTER_RANGE_EMPTY', {
      details: {
        sensor,
        xMin,
        xMax,
        // What the sensor actually covers, so the UI can say where to look instead of just "no".
        dataMinTime: Number.isFinite(dataMinTime) ? dataMinTime : null,
        dataMaxTime: Number.isFinite(dataMaxTime) ? dataMaxTime : null,
        sourceLength: length,
      },
    })
  }

  if (count > MAX_POINTS) {
    throw new PosterSpecError('POSTER_RANGE_TOO_MANY_POINTS', {
      details: {
        sensor,
        points: count,
        maxPoints: MAX_POINTS,
        xMin,
        xMax,
        // Assumes an even sample spacing across the selection, which is what a drop-tower
        // recording has; it is a hint for the UI to propose ("try about 0.9 s"), not a guarantee.
        estimatedMaxSpanSeconds: ((xMax - xMin) * MAX_POINTS) / count,
      },
    })
  }

  const selectedTime = new Float64Array(count)
  const selectedValues = new Float64Array(count)
  let cursor = 0
  let finiteCount = 0
  for (let index = 0; index < length; index++) {
    const instant = time[index] as number
    if (!(instant >= xMin && instant <= xMax)) continue
    const value = values[index] as number
    // NaN is the documented gap marker and belongs in the poster; an infinite gravity level is
    // never a measurement, and the schema would reject it after the expensive encode step anyway.
    if (!Number.isFinite(value) && !Number.isNaN(value)) {
      throw new PosterSpecError('POSTER_SOURCE_INVALID', {
        details: { reason: 'non_finite_value', sensor, index },
      })
    }
    selectedTime[cursor] = instant
    selectedValues[cursor] = value
    if (!Number.isNaN(value)) finiteCount++
    cursor++
  }

  return { time: selectedTime, values: selectedValues, finiteCount }
}

/** Which sensors a `series` selection implies, in the order the schema's `data` object lists them. */
function sensorsFor(series: SeriesSelection): readonly SensorKey[] {
  if (series === 'inner') return ['inner']
  if (series === 'drag') return ['drag']
  return ['inner', 'drag']
}

function requireSource(source: PosterSpecSource, sensor: SensorKey): FullResolutionSeries {
  const series = source[sensor]
  if (series === undefined) {
    throw new PosterSpecError('POSTER_SERIES_MISSING', { details: { sensor, reason: 'not_supplied' } })
  }
  if (!isFullResolutionSeries(series)) {
    // Only reachable from JavaScript or through a cast; the brand is what the type system checks.
    throw new PosterSpecError('POSTER_SOURCE_INVALID', { details: { sensor, reason: 'not_full_resolution' } })
  }
  return series
}

/**
 * The shared body of both public builders.
 *
 * `posterKind` is a parameter here and *not* a field of either public request type: a custom
 * figure can never be filed under the automatic poster's idempotency key, because the only way to
 * obtain a spec with `posterKind: 'auto'` is to call {@link buildAutoPosterPlotSpec}, which takes
 * no presentation arguments to file.
 */
function buildSpec(
  posterKind: PosterKind,
  request: PosterPlotSpecBuildRequest & { readonly posterPresetVersion: PosterPresetVersion },
): PosterPlotSpec {
  const { xMin, xMax } = request
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMin >= xMax) {
    throw new PosterSpecError('POSTER_RANGE_INVALID', { details: { xMin, xMax } })
  }

  // A stored setting can name a preset this build does not have — a rolled-back deployment, an
  // older browser tab — and looking that up unguarded would throw a `TypeError` from inside the
  // builder rather than a code the UI can act on (fall back to the default and say so).
  if (!isPosterPresetVersion(request.posterPresetVersion)) {
    throw new PosterSpecError('POSTER_SPEC_INVALID', {
      details: {
        issues: [{ path: 'posterPresetVersion', message: 'unknown poster preset version' }],
      },
    })
  }
  const preset = getPosterPreset(request.posterPresetVersion)
  const sensors = sensorsFor(request.series)

  const windows = new Map<SensorKey, SelectedWindow>()
  for (const sensor of sensors) {
    windows.set(sensor, selectWindow(sensor, requireSource(request.source, sensor), xMin, xMax))
  }

  // A window of nothing but gaps draws an empty axes box under a real title — a figure that says
  // "this run measured nothing" when what happened is that the reader picked the wrong seconds.
  // One measured sample anywhere in the selection is enough: in a two-sensor comparison a sensor
  // that was silent while the other recorded is itself the finding, so the rule is "no sensor
  // measured anything here", not "every sensor measured something here".
  let totalFiniteCount = 0
  for (const window of windows.values()) totalFiniteCount += window.finiteCount
  if (totalFiniteCount === 0) {
    throw new PosterSpecError('POSTER_RANGE_ALL_GAPS', {
      details: { series: request.series, xMin, xMax },
    })
  }

  // Checked from the point counts before anything is encoded: base64 of an 8MB payload is itself
  // an 8MB string, and there is no reason to build one only to be told it was too big.
  let wireBytes = 0
  for (const window of windows.values()) wireBytes += 2 * expectedBase64Length(window.time.length * 8)
  if (wireBytes > MAX_PAYLOAD_BYTES) {
    throw new PosterSpecError('POSTER_PAYLOAD_TOO_LARGE', {
      details: {
        bytes: wireBytes,
        maxBytes: MAX_PAYLOAD_BYTES,
        series: request.series,
        points: Object.fromEntries([...windows].map(([sensor, window]) => [sensor, window.time.length])),
      },
    })
  }

  const data: { inner?: PosterSeriesData; drag?: PosterSeriesData } = {}
  for (const [sensor, window] of windows) {
    data[sensor] = { time: encodeSeries(window.time), values: encodeSeries(window.values) }
  }

  const candidate: Record<string, unknown> = {
    analysisRevisionId: request.analysisRevisionId,
    runCode: request.runCode,
    posterKind,
    posterPresetVersion: request.posterPresetVersion,
    xMin,
    xMax,
    series: request.series,
    title: request.title ?? '',
    showLegend: request.showLegend ?? true,
    figureWidth: request.figureWidth ?? preset.defaults.figureWidth,
    figureHeight: request.figureHeight ?? preset.defaults.figureHeight,
    dpi: request.dpi ?? preset.defaults.dpi,
    data,
  }
  // Assigned conditionally rather than as `undefined`: the schema is `.strict()` with
  // `exactOptionalPropertyTypes`, so "absent" and "present and undefined" are different documents.
  if (request.yMin !== undefined) candidate.yMin = request.yMin
  if (request.yMax !== undefined) candidate.yMax = request.yMax

  // The builder validates its own output rather than trusting it. Nothing invalid can leave here,
  // and if the assembly above ever drifts from the schema, the failure surfaces as a typed error
  // at the call site instead of as a 400 from the Worker after a round trip.
  const parsed = safeParsePosterPlotSpec(candidate)
  if (!parsed.success) {
    throw new PosterSpecError('POSTER_SPEC_INVALID', {
      cause: parsed.error,
      details: {
        // A compact, renderable summary — never the raw ZodError, whose shape is an implementation
        // detail of the schema and whose message text is written for a developer.
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
  }
  return parsed.data
}

/**
 * Build a validated custom poster spec from a range the user selected on the graph.
 *
 * Throws a {@link PosterSpecError} — never a `ZodError`, never a bare `Error` — for every way the
 * request can fail: an empty or all-gap selection, a selection too large to send, a sensor with no
 * source, an inverted range, or a presentation value outside the schema's bounds.
 *
 * The returned spec always has `posterKind: 'custom'` and is ready to `JSON.stringify` into the
 * body of `POST /api/v1/revisions/:id/posters`.
 */
export function buildPosterPlotSpec(request: PosterPlotSpecBuildRequest): PosterPlotSpec {
  return buildSpec('custom', {
    ...request,
    posterPresetVersion: request.posterPresetVersion ?? DEFAULT_POSTER_PRESET_VERSION,
  })
}

/**
 * Build the automatic poster spec for a revision — the figure the application offers without
 * being asked, in the desktop's default framing.
 *
 * Deterministic by construction: every field comes from the frozen preset (`xMin`/`xMax`, figure
 * geometry, DPI), from the revision (its id and run code), or from the data itself (which sensors
 * have samples in the preset's window). Given the same inputs it always produces the same
 * document and therefore the same `specHash`, which is what lets the browser and any server-side
 * path agree on what "the automatic poster" of a revision is.
 *
 * Sensor selection follows the data: a sensor is drawn if a source series was supplied for it
 * *and* that series has at least one sample inside the preset's x-range. A single-sensor run
 * therefore gets a single-sensor poster instead of a refusal, and neither sensor having anything
 * in the window is a `POSTER_RANGE_EMPTY` refusal rather than an empty figure.
 *
 * The y-axis is left unbounded, which is the preset's deliberate position: `presets.ts` defines
 * defaults for the figure geometry and the x-range but none for y, and the renderer documents
 * that an absent bound leaves Matplotlib's autoscaling in charge. A y-limit is a *local display
 * setting* in this application, so baking one in would make the automatic poster depend on whose
 * browser asked for it first.
 */
export function buildAutoPosterPlotSpec(request: AutoPosterPlotSpecBuildRequest): PosterPlotSpec {
  const posterPresetVersion = request.posterPresetVersion ?? DEFAULT_POSTER_PRESET_VERSION
  const preset = getPosterPreset(posterPresetVersion)
  const { xMin, xMax } = preset.defaults

  const hasInner = hasSamplesInRange(request.source.inner, xMin, xMax)
  const hasDrag = hasSamplesInRange(request.source.drag, xMin, xMax)
  if (!hasInner && !hasDrag) {
    throw new PosterSpecError('POSTER_RANGE_EMPTY', {
      details: {
        sensor: null,
        xMin,
        xMax,
        reason: 'no_sensor_has_samples_in_preset_range',
      },
    })
  }
  const series: SeriesSelection = hasInner && hasDrag ? 'both' : hasInner ? 'inner' : 'drag'

  return buildSpec('auto', {
    analysisRevisionId: request.analysisRevisionId,
    runCode: request.runCode,
    series,
    source: request.source,
    xMin,
    xMax,
    posterPresetVersion,
    // Spelled out rather than left to `buildSpec`'s fallbacks, because the automatic poster's
    // determinism is the point: it is the frozen preset's figure, stated as such at the call site.
    title: '',
    showLegend: true,
    figureWidth: preset.defaults.figureWidth,
    figureHeight: preset.defaults.figureHeight,
    dpi: preset.defaults.dpi,
  })
}

/** Whether a supplied source has at least one sample inside `[xMin, xMax]`. */
function hasSamplesInRange(
  series: FullResolutionSeries | undefined,
  xMin: number,
  xMax: number,
): series is FullResolutionSeries {
  if (series === undefined || !isFullResolutionSeries(series)) return false
  const { time } = series
  for (let index = 0; index < series.length; index++) {
    const instant = time[index] as number
    if (instant >= xMin && instant <= xMax) return true
  }
  return false
}

/**
 * The x-range the automatic poster covers, for a UI that wants to say what it is about to request
 * before requesting it. Reads the frozen preset, so it cannot disagree with
 * {@link buildAutoPosterPlotSpec}.
 */
export function autoPosterRange(version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION): {
  xMin: number
  xMax: number
} {
  const { defaults } = getPosterPreset(version)
  return { xMin: defaults.xMin, xMax: defaults.xMax }
}
