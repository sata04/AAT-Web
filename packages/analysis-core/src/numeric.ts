/**
 * Bit-exact reimplementation of the NumPy reductions the AAT desktop core relies on.
 *
 * `core/statistics.py` computes window means and standard deviations with
 * `ndarray.std()` / `ndarray.mean()`. Those are not naive accumulations: NumPy
 * sums with a pairwise algorithm, so the rounding it produces differs from a
 * straight `for` loop. Reproducing the algorithm — rather than approximating it
 * — is what lets the TypeScript engine match the Python oracle bit-for-bit
 * instead of merely within a tolerance, which in turn keeps the discrete
 * outcomes (which window wins the minimum-standard-deviation search, and how
 * ties resolve) identical rather than probabilistically identical.
 *
 * The algorithm is NumPy's `pairwise_sum_@TYPE@` from
 * `numpy/_core/src/umath/loops_utils.h.src`:
 *
 *   n < 8              straight left-to-right accumulation
 *   n <= blocksize     eight partial accumulators, combined as
 *                      ((r0+r1)+(r2+r3)) + ((r4+r5)+(r6+r7)), remainder added
 *                      left-to-right afterwards
 *   otherwise          split at n/2 rounded down to a multiple of 8, recurse
 *
 * Verified against NumPy 2.5.x on the real strided sliding-window data used by
 * the golden fixtures: zero mismatches in mean, absolute mean and standard
 * deviation. See docs/numerical-compatibility.md.
 */

/** NumPy's `PW_BLOCKSIZE` for the double-precision loops. */
const PW_BLOCKSIZE = 128

/**
 * Pairwise sum of `values[start .. start + length)`.
 *
 * Kept as an explicit offset/length pair rather than subarrays so the rolling
 * statistics can reuse it directly over a window of a larger buffer without
 * allocating a copy per window.
 */
export function pairwiseSum(values: Float64Array, start: number, length: number): number {
  if (length < 8) {
    let accumulator = 0
    for (let index = 0; index < length; index++) accumulator += values[start + index] as number
    return accumulator
  }

  if (length <= PW_BLOCKSIZE) {
    let r0 = values[start] as number
    let r1 = values[start + 1] as number
    let r2 = values[start + 2] as number
    let r3 = values[start + 3] as number
    let r4 = values[start + 4] as number
    let r5 = values[start + 5] as number
    let r6 = values[start + 6] as number
    let r7 = values[start + 7] as number

    let index = 8
    for (; index < length - (length % 8); index += 8) {
      r0 += values[start + index] as number
      r1 += values[start + index + 1] as number
      r2 += values[start + index + 2] as number
      r3 += values[start + index + 3] as number
      r4 += values[start + index + 4] as number
      r5 += values[start + index + 5] as number
      r6 += values[start + index + 6] as number
      r7 += values[start + index + 7] as number
    }

    let result = r0 + r1 + (r2 + r3) + (r4 + r5 + (r6 + r7))
    for (; index < length; index++) result += values[start + index] as number
    return result
  }

  // NumPy rounds the split down to a multiple of 8 so both halves stay on the
  // unrolled path. Reproducing that exactly matters: a different split point
  // gives a different (still valid, but different) rounding.
  let half = length / 2
  half -= half % 8
  return pairwiseSum(values, start, half) + pairwiseSum(values, start + half, length - half)
}

/**
 * Pairwise sum of a transform applied to each element, without materialising
 * the transformed array.
 *
 * Same traversal order as `pairwiseSum`, so `sumTransformed(v, s, n, x => x)`
 * is bit-identical to `pairwiseSum(v, s, n)`.
 */
export function sumTransformed(
  values: Float64Array,
  start: number,
  length: number,
  transform: (value: number) => number,
): number {
  if (length < 8) {
    let accumulator = 0
    for (let index = 0; index < length; index++) accumulator += transform(values[start + index] as number)
    return accumulator
  }

  if (length <= PW_BLOCKSIZE) {
    let r0 = transform(values[start] as number)
    let r1 = transform(values[start + 1] as number)
    let r2 = transform(values[start + 2] as number)
    let r3 = transform(values[start + 3] as number)
    let r4 = transform(values[start + 4] as number)
    let r5 = transform(values[start + 5] as number)
    let r6 = transform(values[start + 6] as number)
    let r7 = transform(values[start + 7] as number)

    let index = 8
    for (; index < length - (length % 8); index += 8) {
      r0 += transform(values[start + index] as number)
      r1 += transform(values[start + index + 1] as number)
      r2 += transform(values[start + index + 2] as number)
      r3 += transform(values[start + index + 3] as number)
      r4 += transform(values[start + index + 4] as number)
      r5 += transform(values[start + index + 5] as number)
      r6 += transform(values[start + index + 6] as number)
      r7 += transform(values[start + index + 7] as number)
    }

    let result = r0 + r1 + (r2 + r3) + (r4 + r5 + (r6 + r7))
    for (; index < length; index++) result += transform(values[start + index] as number)
    return result
  }

  let half = length / 2
  half -= half % 8
  return (
    sumTransformed(values, start, half, transform) +
    sumTransformed(values, start + half, length - half, transform)
  )
}

/** `ndarray.mean()` over a contiguous window. */
export function mean(values: Float64Array, start: number, length: number): number {
  return pairwiseSum(values, start, length) / length
}

/** `np.abs(window).mean()` — the "mean gravity level" AAT reports. */
export function absoluteMean(values: Float64Array, start: number, length: number): number {
  return sumTransformed(values, start, length, Math.abs) / length
}

/**
 * `ndarray.std()` over a contiguous window — population standard deviation via
 * NumPy's two-pass formulation (mean first, then the mean of squared
 * deviations). The two passes are what keep a large DC offset from destroying
 * the result, and `core/statistics.py` explicitly depends on that property.
 */
export function standardDeviation(values: Float64Array, start: number, length: number): number {
  const windowMean = mean(values, start, length)
  const variance = sumTransformed(values, start, length, (value) => {
    const deviation = value - windowMean
    return deviation * deviation
  })
  return Math.sqrt(variance / length)
}

/**
 * Index of the smallest value, ignoring NaN — `np.nanargmin`.
 *
 * Returns the *earliest* index on ties, which the desktop implementation
 * documents as deliberate behaviour, and `-1` when every entry is NaN.
 */
export function nanArgMin(values: Float64Array): number {
  let bestIndex = -1
  let best = Number.POSITIVE_INFINITY
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as number
    // Strict `<` is what makes the earliest of equal minima win.
    if (!Number.isNaN(value) && value < best) {
      best = value
      bestIndex = index
    }
  }
  return bestIndex
}
