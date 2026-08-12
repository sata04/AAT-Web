/**
 * Port of the unified-time-axis and resampling logic from `core/export.py`.
 *
 * The Excel workbook puts both sensors on one shared time column, which means
 * interpolating each sensor onto a common axis. Every decision here is copied
 * from the Python source, including the ones that exist to fix earlier bugs —
 * the comments in `core/export.py` explain each, and they are restated below so
 * a future reader does not "simplify" one away.
 */

/**
 * `MAX_UNIFIED_SAMPLES` in `core/export.py`.
 *
 * An application memory guard, not a spreadsheet limit: at one sample per
 * second this is still about 11 days of data, and its job is to stop a
 * mis-configured sampling rate from allocating tens of gigabytes. The *actual*
 * worksheet limit is enforced separately — see `workbook.ts`, and
 * docs/numerical-compatibility.md for why conflating the two was a bug.
 */
export const MAX_UNIFIED_SAMPLES = 20_000_000

export class ExportRangeError extends Error {
  constructor(
    message: string,
    readonly sampleCount: number,
  ) {
    super(message)
    this.name = 'ExportRangeError'
  }
}

/**
 * Build the shared time axis from a start/end time and a sampling rate.
 *
 * The sample count is decided first and the axis generated from it. Doing it
 * the other way round — `arange(start, end + step, step)` — lets floating-point
 * error slip in one extra element past `end`, which then interpolates to a
 * clamped endpoint value and shows up in the workbook as a duplicated row that
 * was never measured.
 */
export function buildUnifiedTimeAxis(
  startTime: number,
  endTime: number,
  samplingRate: number,
): Float64Array {
  let start = startTime
  let end = endTime
  if (end < start) [start, end] = [end, start]

  const span = end - start
  // Python's round() is half-to-even; at an exact half this differs from
  // Math.round by one sample, which would shift every subsequent timestamp.
  const rawCount = span * samplingRate
  const floor = Math.floor(rawCount)
  const remainder = rawCount - floor
  const rounded =
    remainder > 0.5 ? floor + 1 : remainder < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1
  const sampleCount = rounded + 1

  if (sampleCount > MAX_UNIFIED_SAMPLES) {
    throw new ExportRangeError(
      `The unified time axis would need ${sampleCount} samples, above the ${MAX_UNIFIED_SAMPLES} ` +
        'limit. Check the sampling rate and the trim range.',
      sampleCount,
    )
  }

  const count = Math.max(sampleCount, 1)
  const axis = new Float64Array(count)
  for (let index = 0; index < count; index++) {
    // start + index / rate, matching `start + np.arange(n) / rate` exactly
    // (dividing the integer index reproduces NumPy's rounding, whereas
    // accumulating `+= step` would drift).
    axis[index] = start + index / samplingRate
  }
  return axis
}

/**
 * Linearly interpolate one sensor onto the shared axis.
 *
 * Three behaviours are load-bearing:
 *  - Non-finite timestamps are dropped before interpolating; a sample with no
 *    position on the time axis cannot be placed on it.
 *  - The remaining samples are sorted by time with a **stable** sort.
 *    `np.interp` assumes ascending x and silently returns wrong values
 *    otherwise, and stability keeps duplicate timestamps in their original
 *    order so the result is deterministic.
 *  - Points outside the sensor's own measured span become NaN (a blank cell),
 *    never a value clamped to the nearest endpoint. A clamped value looks like
 *    real data and is not.
 */
export function resampleToAxis(
  unifiedTime: Float64Array,
  times: Float64Array,
  values: Float64Array,
): Float64Array {
  if (times.length !== values.length) {
    throw new ExportRangeError(
      `Time and value arrays differ in length: time=${times.length}, values=${values.length}`,
      0,
    )
  }

  const usableIndices: number[] = []
  for (let index = 0; index < times.length; index++) {
    if (Number.isFinite(times[index] as number)) usableIndices.push(index)
  }

  const output = new Float64Array(unifiedTime.length)
  if (usableIndices.length === 0) {
    output.fill(Number.NaN)
    return output
  }

  // Stable sort by time: Array.prototype.sort is required to be stable, and
  // comparing indices as a tiebreaker makes that explicit rather than implied.
  usableIndices.sort((a, b) => {
    const timeA = times[a] as number
    const timeB = times[b] as number
    if (timeA < timeB) return -1
    if (timeA > timeB) return 1
    return a - b
  })

  const sortedTimes = new Float64Array(usableIndices.length)
  const sortedValues = new Float64Array(usableIndices.length)
  for (let index = 0; index < usableIndices.length; index++) {
    const source = usableIndices[index] as number
    sortedTimes[index] = times[source] as number
    sortedValues[index] = values[source] as number
  }

  const first = sortedTimes[0] as number
  const last = sortedTimes[sortedTimes.length - 1] as number

  // Both arrays are ascending, so walk them together instead of binary
  // searching per output sample.
  let cursor = 0
  for (let index = 0; index < unifiedTime.length; index++) {
    const target = unifiedTime[index] as number
    if (target < first || target > last) {
      output[index] = Number.NaN
      continue
    }
    while (cursor < sortedTimes.length - 2 && (sortedTimes[cursor + 1] as number) < target) cursor++
    output[index] = interpolateAt(sortedTimes, sortedValues, target, cursor)
  }
  return output
}

/** `np.interp` for a single point, given a bracketing index hint. */
function interpolateAt(
  sortedTimes: Float64Array,
  sortedValues: Float64Array,
  target: number,
  hint: number,
): number {
  let low = hint
  // The hint can lag when the axis jumps; nudge it into place.
  while (low < sortedTimes.length - 2 && (sortedTimes[low + 1] as number) < target) low++
  while (low > 0 && (sortedTimes[low] as number) > target) low--

  const timeLow = sortedTimes[low] as number
  const timeHigh = sortedTimes[low + 1] as number
  const valueLow = sortedValues[low] as number
  const valueHigh = sortedValues[low + 1] as number

  if (target === timeLow) return valueLow
  if (target === timeHigh) return valueHigh
  // Duplicate timestamps: np.interp takes the later sample's value.
  if (timeHigh === timeLow) return valueHigh

  const fraction = (target - timeLow) / (timeHigh - timeLow)
  return valueLow + fraction * (valueHigh - valueLow)
}

/**
 * The union of both sensors' measured spans.
 *
 * Deliberately the union and not the intersection: trimming to the overlap
 * would drop a region one sensor genuinely measured, and the Statistics sheet
 * is computed over each sensor's full span, so the two sheets would stop
 * agreeing. Regions outside a given sensor's own span stay blank.
 */
export function unionTimeRange(
  ranges: Array<{ min: number; max: number } | null>,
): { start: number; end: number } | null {
  const present = ranges.filter((range): range is { min: number; max: number } => range !== null)
  if (present.length === 0) return null
  return {
    start: Math.min(...present.map((range) => range.min)),
    end: Math.max(...present.map((range) => range.max)),
  }
}

/** Finite min/max of a series, or null when it has no finite samples. */
export function finiteRange(values: Float64Array | null): { min: number; max: number } | null {
  if (values === null || values.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let seen = false
  for (let index = 0; index < values.length; index++) {
    const value = values[index] as number
    if (!Number.isFinite(value)) continue
    seen = true
    if (value < min) min = value
    if (value > max) max = value
  }
  return seen ? { min, max } : null
}
