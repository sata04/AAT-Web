/**
 * The one way sample data is allowed into a poster spec: a whole, full-resolution sensor series.
 *
 * `docs/web-architecture.md` states the rule that this module exists to make mechanical —
 * decimated data is for drawing pixels and for nothing else. A poster is not a screenshot: it is
 * a formal figure that gets printed, published and cited, and a poster drawn from the graph's
 * min/max-per-column view (`apps/web/src/graph/decimate.ts`) would be a *scientifically different
 * figure* from the same range at full resolution — same envelope, different curve, different
 * apparent noise, different everything a reader would measure off it.
 *
 * Three mechanisms keep that from happening by accident, and they are worth stating together
 * because none of them alone is enough:
 *
 *  1. **A nominal brand.** {@link FullResolutionSeries} carries a module-private `Symbol` that is
 *     written at runtime and never exported, exactly as `decimate.ts` marks its `DisplaySeries`.
 *     No object literal outside this file can satisfy the type, and no JSON, structured clone or
 *     hand-built object can forge it at runtime either (the symbol is `Symbol()`, not
 *     `Symbol.for()`, so it is not reachable through the global registry). The only door is
 *     {@link asFullResolutionSeries}, which is a *promise* made at one call site, the same way
 *     `apps/web`'s `asFullResolution` is — deliberately conspicuous, because feeding a
 *     `DisplaySeries`'s `y` array through it would require writing that lie out in full.
 *  2. **The builder slices, the caller does not.** `builder.ts` takes this whole-series value plus
 *     an x-range and does the windowing itself. There is no parameter anywhere in this package for
 *     handing over pre-sliced samples, and none for a point budget, a stride or a target width —
 *     so there is no supported way to *ask* for fewer points than the range contains.
 *  3. **Over-budget is a refusal, never a reduction.** A selection larger than `MAX_POINTS` is
 *     rejected with `POSTER_RANGE_TOO_MANY_POINTS` and a suggested narrower span. Silently
 *     downsampling to fit would be the same scientific error as sending the display view, arrived
 *     at by a more helpful-looking route.
 *
 * What this cannot do is *detect* decimation: a decimated array is a `Float64Array` of finite
 * numbers on an ascending axis, which is indistinguishable from a real one by inspection. Hence
 * the brand — the honesty is enforced at the point where a human writes the promise, not by a
 * heuristic that would eventually be wrong in both directions.
 */

import { PosterSpecError } from './errors.ts'

/**
 * The nominal marker.
 *
 * A real symbol, not a `declare`d phantom: it is written at runtime, so `isFullResolutionSeries`
 * is a genuine check rather than a type-level assertion, and an untyped JavaScript caller (a test
 * harness, a Worker route reading JSON) cannot slip a plain object past the builder either.
 */
const FULL_RESOLUTION_SERIES = Symbol('aat.plotSpec.fullResolutionSeries')

/**
 * One sensor's complete, unmodified series as the analysis engine produced it: every original
 * sample, on that sensor's own sync-adjusted time axis.
 *
 * "Complete" is load-bearing in both directions. The arrays must not be decimated, and they must
 * also not be pre-trimmed to the range the poster will show — the builder needs the whole series
 * to answer "your range selects nothing; the data covers 0.00–1.45 s", which is the difference
 * between a usable error message and a mystery.
 *
 * The arrays are referenced, not copied: a full run can be millions of samples, and duplicating it
 * to build a figure that will use a few thousand of them would be a real memory cost for no
 * safety gain. The builder copies only the window it selects, so a later mutation of the source
 * cannot reach a spec that was already built.
 */
export interface FullResolutionSeries {
  readonly [FULL_RESOLUTION_SERIES]: true
  /** Seconds, on this sensor's own sync-adjusted axis. The two sensors do not share a time base. */
  readonly time: Float64Array
  /** Gravity level (G), aligned index-for-index with `time`. NaN means a gap — see `wire.ts`. */
  readonly values: Float64Array
  /** Sample count, equal for both arrays. Convenience for a UI that wants to show the source size. */
  readonly length: number
}

/**
 * Promise that `time` and `values` are a sensor's full-resolution series, and wrap them for the
 * builder.
 *
 * Call this where the samples genuinely come straight from the analysis engine — in `apps/web`
 * that is a `Dataset`'s `FullResolutionArray` fields, which are themselves branded at the single
 * point where the worker payload crosses into the main thread. It is a promise, not a conversion,
 * and it is the only door in.
 *
 * The runtime checks here are the ones that *can* be made: both arguments really are
 * `Float64Array`s (not `Array`s, not `Float32Array`s — a `Float32Array` would silently round every
 * published sample), and they are the same length, since a poster whose time axis and values
 * disagree in length is not a figure of anything. Sample *content* is checked in the builder,
 * against the selected window only, so a run with a single spoiled sample far outside the poster's
 * range is not rejected for a value the poster would never draw.
 */
export function asFullResolutionSeries(time: Float64Array, values: Float64Array): FullResolutionSeries {
  if (!(time instanceof Float64Array) || !(values instanceof Float64Array)) {
    throw new PosterSpecError('POSTER_SOURCE_INVALID', {
      details: {
        reason: 'not_float64_array',
        timeType: describeArray(time),
        valuesType: describeArray(values),
      },
    })
  }
  if (time.length !== values.length) {
    throw new PosterSpecError('POSTER_SOURCE_INVALID', {
      details: { reason: 'length_mismatch', timeLength: time.length, valuesLength: values.length },
    })
  }
  return { [FULL_RESOLUTION_SERIES]: true, time, values, length: time.length }
}

/**
 * Runtime check for the brand, used by the builder before it trusts anything it was handed and
 * available to a Worker route that builds a spec from values it did not mint itself.
 */
export function isFullResolutionSeries(value: unknown): value is FullResolutionSeries {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[FULL_RESOLUTION_SERIES] === true
  )
}

/** Name a rejected argument for the error details without ever putting its contents in them. */
function describeArray(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  const constructorName = (value as { constructor?: { name?: unknown } }).constructor?.name
  return typeof constructorName === 'string' ? constructorName : typeof value
}
