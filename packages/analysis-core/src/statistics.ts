/**
 * Port of `core/statistics.py`.
 *
 * The desktop implementation has two code paths. The default one computes each
 * window directly in two passes; a cumulative-sum approximation takes over only
 * when `num_windows * window_samples` exceeds 20,000,000 elements. The comments
 * in the Python source explain why the exact path is the default: a single
 * extreme outlier poisons a global running Sum(x^2) for every window after it,
 * and release-shock samples make that a real case rather than a theoretical one.
 *
 * This port implements the exact path only, and raises when a request would
 * have crossed into the approximation. Reasons:
 *   - the approximate path is a fallback the desktop app warns about, not
 *     behaviour worth reproducing;
 *   - a browser cannot usefully allocate that shape anyway;
 *   - silently switching to a less accurate algorithm is precisely the kind of
 *     hidden transformation the analysis contract forbids.
 * The threshold and the failure are documented in docs/numerical-compatibility.md.
 */

import { absoluteMean, mean, nanArgMin, standardDeviation, sumTransformed } from './numeric.ts'

/** `_EXACT_ELEMENT_BUDGET` in `core/statistics.py`. */
export const EXACT_ELEMENT_BUDGET = 20_000_000

export interface StatisticsConfig {
  /** Analysis window in seconds. */
  windowSize: number
  /** Sampling rate in Hz. */
  samplingRate: number
}

export interface WindowStatistics {
  /** Mean of |gravity| inside the minimum-standard-deviation window. */
  mean: number | null
  /** Start time of that window, taken from the aligned time series. */
  startTime: number | null
  /** The standard deviation itself. */
  std: number | null
}

export const EMPTY_WINDOW_STATISTICS: WindowStatistics = { mean: null, startTime: null, std: null }

export class AnalysisParameterError extends Error {
  constructor(
    message: string,
    readonly parameter: string,
  ) {
    super(message)
    this.name = 'AnalysisParameterError'
  }
}

export class AnalysisSizeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalysisSizeError'
  }
}

/**
 * `_positive_float` — reject non-positive or non-finite analysis parameters.
 *
 * Rounding zero or a negative value down to a one-sample window would report a
 * flawless std of 0 for meaningless input, so this fails loudly instead.
 */
export function positiveFloat(value: unknown, name: string): number {
  const numberValue = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new AnalysisParameterError(
      `${name} must be a finite number greater than zero (received ${String(value)})`,
      name,
    )
  }
  return numberValue
}

/**
 * Python's `round()` — banker's rounding, half to even.
 *
 * `window_size_samples = max(1, round(window_size * sampling_rate))` decides how
 * many samples a window holds, so a half-up rounding here would silently pick a
 * different window width than the desktop app for values such as 0.0005 s at
 * 1 kHz. JavaScript's `Math.round` is half-up and would diverge.
 */
export function roundHalfToEven(value: number): number {
  if (!Number.isFinite(value)) return value
  const floor = Math.floor(value)
  const remainder = value - floor
  if (remainder > 0.5) return floor + 1
  if (remainder < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** Window width in samples, matching `max(1, round(window_size * sampling_rate))`. */
export function windowSampleCount(windowSize: number, samplingRate: number): number {
  return Math.max(1, roundHalfToEven(windowSize * samplingRate))
}

/**
 * Per-window absolute mean and standard deviation.
 *
 * Windows containing any missing sample are excluded from the search by being
 * set to NaN: a standard deviation is only defined over a fully observed
 * window, and allowing partial ones lets a window holding two valid samples win
 * with std ~ 0 while reporting a mean computed over a different sample count.
 */
function rollingWindowStatistics(
  values: Float64Array,
  validMask: Uint8Array,
  windowSamples: number,
  windowCount: number,
): { means: Float64Array; stdDevs: Float64Array; anyComplete: boolean } {
  if (windowCount * windowSamples > EXACT_ELEMENT_BUDGET) {
    throw new AnalysisSizeError(
      `Analysis would need ${windowCount * windowSamples} window elements, above the ` +
        `${EXACT_ELEMENT_BUDGET} exact-computation budget. Narrow the analysis range or ` +
        'reduce the window size; the desktop application falls back to a less accurate ' +
        'cumulative-sum approximation here, which this engine deliberately does not.',
    )
  }

  const means = new Float64Array(windowCount)
  const stdDevs = new Float64Array(windowCount)
  let anyComplete = false

  // Rolling count of valid samples, so completeness costs O(n) rather than O(n*w).
  let validInWindow = 0
  for (let index = 0; index < windowSamples; index++) validInWindow += validMask[index] as number

  for (let windowStart = 0; windowStart < windowCount; windowStart++) {
    if (windowStart > 0) {
      validInWindow -= validMask[windowStart - 1] as number
      validInWindow += validMask[windowStart + windowSamples - 1] as number
    }
    if (validInWindow >= windowSamples) {
      anyComplete = true
      means[windowStart] = absoluteMean(values, windowStart, windowSamples)
      stdDevs[windowStart] = standardDeviation(values, windowStart, windowSamples)
    } else {
      means[windowStart] = Number.NaN
      stdDevs[windowStart] = Number.NaN
    }
  }

  return { means, stdDevs, anyComplete }
}

/**
 * `calculate_statistics` — locate the minimum-standard-deviation window.
 *
 * `gravity` and `time` must be the same length and already aligned (each sensor
 * carries its own time axis in AAT, so callers pass matching pairs).
 */
export function calculateStatistics(
  gravity: Float64Array,
  time: Float64Array,
  config: StatisticsConfig,
): WindowStatistics {
  const windowSize = positiveFloat(config.windowSize, 'windowSize')
  const samplingRate = positiveFloat(config.samplingRate, 'samplingRate')
  const windowSamples = windowSampleCount(windowSize, samplingRate)

  if (gravity.length !== time.length) {
    throw new AnalysisParameterError(
      `Time and data arrays differ in length: gravity=${gravity.length}, time=${time.length}`,
      'length',
    )
  }

  if (gravity.length < windowSamples) return EMPTY_WINDOW_STATISTICS

  const windowCount = gravity.length - windowSamples + 1
  if (windowCount <= 0) return EMPTY_WINDOW_STATISTICS

  // +/-Infinity is not a measurement. Treating it as valid would poison the
  // whole channel; the desktop core makes the same choice.
  const validMask = new Uint8Array(gravity.length)
  let anyValid = false
  for (let index = 0; index < gravity.length; index++) {
    const isFinite = Number.isFinite(gravity[index] as number)
    validMask[index] = isFinite ? 1 : 0
    if (isFinite) anyValid = true
  }
  if (!anyValid) return EMPTY_WINDOW_STATISTICS

  // Windows are computed over the raw buffer, but invalid entries must not
  // contribute a value. The desktop core zero-fills them and then discards any
  // window that was not fully observed, so the zeros can never reach a result.
  let analysisValues = gravity
  if (validMask.some((flag) => flag === 0)) {
    analysisValues = new Float64Array(gravity.length)
    for (let index = 0; index < gravity.length; index++) {
      analysisValues[index] = validMask[index] === 1 ? (gravity[index] as number) : 0
    }
  }

  const { means, stdDevs, anyComplete } = rollingWindowStatistics(
    analysisValues,
    validMask,
    windowSamples,
    windowCount,
  )
  if (!anyComplete) return EMPTY_WINDOW_STATISTICS

  const minIndex = nanArgMin(stdDevs)
  if (minIndex < 0) return EMPTY_WINDOW_STATISTICS

  return {
    mean: means[minIndex] as number,
    startTime: time[minIndex] as number,
    std: stdDevs[minIndex] as number,
  }
}

export interface RangeStatistics {
  mean: number | null
  absMean: number | null
  std: number | null
  min: number | null
  max: number | null
  range: number | null
  /** Number of finite samples the statistics were computed from. */
  count: number
  /** Number of samples excluded as NaN or +/-Infinity. */
  missing: number
}

const EMPTY_RANGE_STATISTICS: RangeStatistics = {
  mean: null,
  absMean: null,
  std: null,
  min: null,
  max: null,
  range: null,
  count: 0,
  missing: 0,
}

/**
 * `calculate_range_statistics` — statistics for a user-selected span.
 *
 * Non-finite samples are excluded and counted rather than allowed to turn every
 * output into NaN, so a single dropout in the selection does not present the
 * user with unexplained blanks.
 */
export function calculateRangeStatistics(values: Float64Array): RangeStatistics {
  if (values.length === 0) return { ...EMPTY_RANGE_STATISTICS }

  const finite = new Float64Array(values.length)
  let finiteCount = 0
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as number
    if (Number.isFinite(value)) finite[finiteCount++] = value
  }
  const missing = values.length - finiteCount
  if (finiteCount === 0) return { ...EMPTY_RANGE_STATISTICS, missing }

  const view = finite.subarray(0, finiteCount)
  const meanValue = mean(view, 0, finiteCount)
  const absMeanValue = absoluteMean(view, 0, finiteCount)

  let minimum = view[0] as number
  let maximum = view[0] as number
  for (let index = 1; index < finiteCount; index++) {
    const value = view[index] as number
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }

  // np.std() over the finite subset — same two-pass shape as the window path.
  const variance =
    sumTransformed(view, 0, finiteCount, (value) => {
      const deviation = value - meanValue
      return deviation * deviation
    }) / finiteCount

  return {
    mean: meanValue,
    absMean: absMeanValue,
    std: Math.sqrt(variance),
    min: minimum,
    max: maximum,
    range: maximum - minimum,
    count: finiteCount,
    missing,
  }
}
