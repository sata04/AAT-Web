/**
 * Wire format for the numeric series carried inside a {@link PosterPlotSpec} (see `spec.ts`).
 *
 * Plain JSON has no representation for NaN or +/-Infinity, so each series is carried as base64 of
 * a little-endian `Float64Array` rather than a JSON number array (see `codec.ts` for why, and for
 * exactness guarantees). Two arrays are sent per requested series — `time` and `values` — each
 * with its own {@link EncodedFloat64Series} envelope.
 *
 * `NaN` in a `values` array means "gap": a sample the poster should skip (draw as a break in the
 * line) rather than plot as zero. `time` never has this meaning — every time sample must be a
 * real, finite instant, because a gap is expressed by the *value* at that instant being absent,
 * not by the instant itself being undefined. `spec.ts`'s validation enforces this asymmetry:
 * `time` arrays reject NaN and +/-Infinity outright, `values` arrays reject only +/-Infinity
 * (an infinite gravity level is never legitimate data, whereas NaN is the documented gap marker).
 */

import { decodeFloat64Array, encodeFloat64Array, expectedBase64Length, STRICT_BASE64_PATTERN } from './codec.ts'

/** A full-resolution numeric series as it appears on the wire. */
export interface EncodedFloat64Series {
  /** Base64 of the little-endian Float64Array bytes (see `codec.ts`). */
  data: string
  /** Element count, redundant with `data`'s decoded length but checked on decode to catch truncation or tampering. */
  length: number
}

/** Encode a numeric series for the wire. `null` entries become `NaN` (see module docs on gaps). */
export function encodeSeries(values: Float64Array | ReadonlyArray<number | null>): EncodedFloat64Series {
  const float64 =
    values instanceof Float64Array ? values : Float64Array.from(values, (value) => (value === null ? NaN : value))
  return { data: encodeFloat64Array(float64), length: float64.length }
}

/**
 * Decode a wire series back to a `Float64Array`. Throws if the declared `length` does not match
 * the number of elements actually decoded from `data` — this is the tamper/truncation check the
 * `length` field exists for, independent of the base64-length check `spec.ts` runs at validation
 * time (which catches the same class of corruption before this function is ever called on
 * untrusted input).
 */
export function decodeSeries(series: EncodedFloat64Series): Float64Array {
  const values = decodeFloat64Array(series.data)
  if (values.length !== series.length) {
    throw new Error(
      `Series length mismatch: header declares ${series.length} elements, decoded ${values.length}`,
    )
  }
  return values
}

/** Structural well-formedness check used by `spec.ts`: valid base64 alphabet, and the length that `length` implies. */
export function isWellFormedEncodedSeries(series: EncodedFloat64Series): boolean {
  if (!Number.isInteger(series.length) || series.length < 0) return false
  if (!STRICT_BASE64_PATTERN.test(series.data)) return false
  return series.data.length === expectedBase64Length(series.length * 8)
}
