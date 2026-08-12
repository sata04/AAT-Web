/**
 * The G-quality sweep — `GQualityWorker.run` from `gui/workers.py`, without Qt.
 *
 * The same minimum-standard-deviation search is repeated across a range of
 * window widths, which is what turns a single "how quiet was it" number into a
 * curve: a facility that looks excellent over 0.1 s and poor over 1.0 s is a
 * different facility from one that is merely mediocre at both.
 *
 * The window-size ladder is generated with NumPy's `arange` semantics rather
 * than a plain loop, because the two do not agree: `arange` derives its step
 * from the *materialised* first two elements, so the ladder drifts in a
 * specific, reproducible way (0.15000000000000002, 0.20000000000000004, ...)
 * and those exact values are recorded in the goldens and reported to the user.
 */

import type { AnalysisConfig } from './config.ts'
import { AnalysisSizeError, calculateStatistics, windowSampleCount } from './statistics.ts'
import type { FilterResult } from './pipeline.ts'
import { type AnalysisWarning, warning } from './warnings.ts'

export interface GQualityRow {
  /** Window width in seconds, exactly as the ladder produced it. */
  windowSize: number
  innerStartTime: number | null
  innerMean: number | null
  innerStd: number | null
  dragStartTime: number | null
  dragMean: number | null
  dragStd: number | null
}

export interface GQualityProgress {
  /** Window sizes finished so far. */
  completed: number
  total: number
  /** `int((i + 1) / total * 100)`, matching the desktop progress signal. */
  percent: number
  /** The window size just finished. */
  windowSize: number
}

export interface GQualityResult {
  rows: GQualityRow[]
  warnings: AnalysisWarning[]
}

/**
 * `np.arange(start, end + tolerance, step)`, filtered to `<= end + tolerance`
 * and clamped to `end`.
 *
 * NumPy fills the buffer as `start, start + step, then start + i * delta` where
 * `delta = (start + step) - start` — a value that is generally *not* `step`
 * once rounding is involved. Using `step` directly produces a ladder that
 * differs from the reference at the third element onward.
 */
export function gQualityWindowSizes(start: number, end: number, step: number): Float64Array {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(start), Math.abs(end), Math.abs(step)) * 8
  const stop = end + tolerance
  const count = Math.max(0, Math.ceil((stop - start) / step))
  if (count === 0) return new Float64Array(0)

  const ladder = new Float64Array(count)
  ladder[0] = start
  if (count > 1) {
    ladder[1] = start + step
    const delta = (ladder[1] as number) - start
    for (let index = 2; index < count; index++) ladder[index] = start + index * delta
  }

  const kept: number[] = []
  for (let index = 0; index < count; index++) {
    const value = ladder[index] as number
    if (value <= stop) kept.push(Math.min(value, end))
  }
  return Float64Array.from(kept)
}

/**
 * Run the sweep over the filtered series.
 *
 * A sensor is skipped for a given width when it holds fewer samples than the
 * window needs, and a row is emitted only when at least one sensor produced a
 * mean — an all-null row would draw a gap in the curve that looks like a
 * measurement, not like an absence of one.
 */
export function calculateGQuality(
  filtered: FilterResult,
  config: AnalysisConfig,
  onProgress?: (progress: GQualityProgress) => void,
): GQualityResult {
  const warnings: AnalysisWarning[] = []
  const samplingRate = config.samplingRate
  const innerLength = filtered.inner.gravity.length
  const dragLength = filtered.drag.gravity.length
  const hasInner = innerLength > 0
  const hasDrag = dragLength > 0

  const windowSizes = gQualityWindowSizes(config.gQualityStart, config.gQualityEnd, config.gQualityStep)
  const total = windowSizes.length

  if (!hasInner && !hasDrag) {
    warnings.push(
      warning('GQUALITY_SKIPPED', 'Neither sensor has data, so the G-quality sweep was skipped.', {
        reason: 'no-data',
      }),
    )
    return { rows: [], warnings }
  }

  const minimumWindowSamples = windowSampleCount(config.gQualityStart, samplingRate)
  const enoughData =
    (hasInner && innerLength >= minimumWindowSamples) || (hasDrag && dragLength >= minimumWindowSamples)
  if (!enoughData) {
    warnings.push(
      warning(
        'GQUALITY_SKIPPED',
        `Both series are shorter than the smallest window (${minimumWindowSamples} samples), so the ` +
          'G-quality sweep was skipped.',
        { reason: 'too-short', requiredSamples: minimumWindowSamples },
      ),
    )
    return { rows: [], warnings }
  }

  const rows: GQualityRow[] = []
  for (let index = 0; index < total; index++) {
    const windowSize = windowSizes[index] as number
    const windowSamples = windowSampleCount(windowSize, samplingRate)
    const statisticsConfig = { windowSize, samplingRate }

    let innerStartTime: number | null = null
    let innerMean: number | null = null
    let innerStd: number | null = null
    let dragStartTime: number | null = null
    let dragMean: number | null = null
    let dragStd: number | null = null

    if (hasInner && innerLength >= windowSamples) {
      try {
        const statistics = calculateStatistics(
          filtered.inner.gravity,
          filtered.inner.time,
          statisticsConfig,
        )
        innerMean = statistics.mean
        innerStartTime = statistics.startTime
        innerStd = statistics.std
      } catch (error) {
        warnings.push(oversizedWindowWarning(error, 'inner', windowSize))
      }
    }

    if (hasDrag && dragLength >= windowSamples) {
      try {
        const statistics = calculateStatistics(filtered.drag.gravity, filtered.drag.time, statisticsConfig)
        dragMean = statistics.mean
        dragStartTime = statistics.startTime
        dragStd = statistics.std
      } catch (error) {
        warnings.push(oversizedWindowWarning(error, 'drag', windowSize))
      }
    }

    if (innerMean !== null || dragMean !== null) {
      rows.push({ windowSize, innerStartTime, innerMean, innerStd, dragStartTime, dragMean, dragStd })
    }

    onProgress?.({
      completed: index + 1,
      total,
      percent: Math.trunc(((index + 1) / total) * 100),
      windowSize,
    })
  }

  return { rows, warnings }
}

/**
 * Only the exact-computation budget is caught per window.
 *
 * The desktop worker swallows every exception here and leaves the point blank.
 * That is right for the size limit — losing one point on a curve beats losing
 * the analysis — but wrong for an invalid window size or sampling rate, which
 * would silently blank every point instead of telling the user their
 * configuration is unusable, so those still propagate.
 */
function oversizedWindowWarning(error: unknown, sensor: 'inner' | 'drag', windowSize: number): AnalysisWarning {
  if (!(error instanceof AnalysisSizeError)) throw error
  return warning(
    'GQUALITY_WINDOW_TOO_LARGE',
    `The ${sensor} channel could not be analysed at a ${windowSize} s window: ${error.message}`,
    { sensor, windowSize },
  )
}
