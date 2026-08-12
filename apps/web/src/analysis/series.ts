/**
 * The full-resolution / display-resolution boundary, expressed in the type system.
 *
 * `docs/web-architecture.md` states the rule: decimated data is used for exactly
 * one thing, drawing pixels. It must never reach the minimum-standard-deviation
 * search, the G-quality sweep, range statistics, Excel, a snapshot or a poster.
 *
 * A comment cannot enforce that, so the *trustworthy* value is the branded one:
 * `FullResolutionArray` is a `Float64Array` that carries a phantom marker, and
 * every consumer that computes a published number demands it. A plain
 * `Float64Array` — which is what `decimateForDisplay` hands back inside a
 * `DisplaySeries` — is not assignable to it, so feeding decimated samples to
 * statistics is a compile error rather than a subtly wrong figure.
 *
 * Branding the good value rather than the bad one matters: a brand on the
 * *display* type would still let an unbranded array slip into a statistics call.
 * With the brand on the full-resolution side, the only way in is
 * {@link asFullResolution}, which exists at exactly two places — the analysis
 * worker boundary and the snapshot decoder — and nowhere else.
 */

declare const FULL_RESOLUTION: unique symbol

/** A `Float64Array` that is known to hold every original sample. */
export type FullResolutionArray = Float64Array & { readonly [FULL_RESOLUTION]: true }

/**
 * Mark an array as full resolution.
 *
 * Call this only where the samples genuinely come straight from the analysis
 * engine. It is a promise, not a conversion.
 */
export function asFullResolution(values: Float64Array): FullResolutionArray {
  return values as FullResolutionArray
}

/** Shared empty series. Never transferred, so its buffer can never be detached. */
export const EMPTY_FULL_RESOLUTION: FullResolutionArray = asFullResolution(new Float64Array(0))

/** One sensor's aligned pair of full-resolution series. */
export interface SensorSeriesView {
  readonly time: FullResolutionArray
  readonly gravity: FullResolutionArray
}
