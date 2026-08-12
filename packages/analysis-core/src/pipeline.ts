/**
 * Port of `load_and_process_data()` and `filter_data()` from
 * `reference/python/core/data_processor.py`.
 *
 * This is the stage that turns raw cells into the two synchronised, trimmed
 * gravity series everything downstream measures. Three behaviours here are
 * contract rather than implementation detail, and each has a golden fixture:
 *
 *   - rows whose timestamp is unusable are *masked, not dropped*, because
 *     dropping them changes the spacing between neighbouring samples and
 *     therefore changes what a window measured in seconds actually covers;
 *   - the sync fallback chain (Inner borrows the Drag Shield's index when it has
 *     none of its own, otherwise sample 0);
 *   - the two sensors are synchronised and trimmed *independently*, each with
 *     its own time axis and its own bounds.
 */

import type { AnalysisConfig } from './config.ts'
import type { CsvColumn, CsvTable } from './csv.ts'
import { toNumericColumn } from './csv.ts'
import { ColumnNotFoundError, DataProcessingError } from './errors.ts'
import { type AnalysisWarning, type SensorId, warning } from './warnings.ts'

const EMPTY_SERIES = new Float64Array(0)

/** One sensor's aligned pair of series. Both are empty when the sensor is off. */
export interface SensorSeries {
  /** Time relative to that sensor's own sync point, in seconds. */
  time: Float64Array
  /** Acceleration divided by `gravityConstant`, in G. */
  gravity: Float64Array
}

/** How a sync index was arrived at when no sample crossed the threshold. */
export type SyncFallback = 'borrowed-drag' | 'first-sample'

export interface SyncResult {
  /** Index used to zero the Inner Capsule time axis; null when the sensor is off. */
  innerIndex: number | null
  dragIndex: number | null
  innerFallback: SyncFallback | null
  dragFallback: SyncFallback | null
  /** How many samples satisfied |acceleration| < threshold. */
  innerCandidateCount: number
  dragCandidateCount: number
}

export interface LoadedData {
  inner: SensorSeries
  drag: SensorSeries
  sync: SyncResult
  /** Rows in the source table (before any trimming). */
  sampleCount: number
  warnings: AnalysisWarning[]
}

function coercionWarning(column: CsvColumn, coercedCount: number): AnalysisWarning {
  return warning(
    'CELLS_COERCED',
    `${coercedCount} cell(s) in column '${column.name}' could not be read as numbers and were ` +
      'treated as missing.',
    { column: column.name, count: coercedCount },
  )
}

/** `np.median` over an already-sorted, strictly positive sample. */
function medianOfSorted(sorted: Float64Array): number {
  const length = sorted.length
  const middle = length >> 1
  if (length % 2 === 1) return sorted[middle] as number
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

/**
 * `np.percentile(..., method='linear')` over an already-sorted sample.
 *
 * NumPy's interpolation is not a plain `a + t * (b - a)`: past the midpoint it
 * anchors on the upper element instead, which keeps the result monotone in `t`.
 * Reproduced here so the evenness check trips at the same threshold.
 */
function percentileOfSorted(sorted: Float64Array, quantile: number): number {
  const length = sorted.length
  if (length === 1) return sorted[0] as number
  const virtualIndex = quantile * (length - 1)
  const lower = Math.floor(virtualIndex)
  const upper = Math.min(lower + 1, length - 1)
  const fraction = virtualIndex - lower
  const low = sorted[lower] as number
  const high = sorted[upper] as number
  const difference = high - low
  return fraction >= 0.5 ? high - difference * (1 - fraction) : low + difference * fraction
}

/**
 * `_validate_time_axis` — never stops the analysis, only records what is odd.
 *
 * A disturbed time axis happens in real measurements; the point is to leave a
 * trace before the start-point search and the interpolation downstream turn it
 * into a plausible-looking wrong answer.
 */
function validateTimeAxis(time: Float64Array, config: AnalysisConfig): AnalysisWarning[] {
  const warnings: AnalysisWarning[] = []

  if (time.length === 0) {
    throw new DataProcessingError('TIME_COLUMN_EMPTY', 'The time column has no rows.')
  }

  const finite = new Float64Array(time.length)
  let finiteCount = 0
  for (let index = 0; index < time.length; index++) {
    const value = time[index] as number
    if (Number.isFinite(value)) finite[finiteCount++] = value
  }
  if (finiteCount === 0) {
    throw new DataProcessingError('TIME_COLUMN_INVALID', 'The time column holds no usable numbers.')
  }
  if (finiteCount < time.length) {
    warnings.push(
      warning('TIME_NON_FINITE_SAMPLES', `The time column has ${time.length - finiteCount} unusable sample(s).`, {
        count: time.length - finiteCount,
      }),
    )
  }

  if (finiteCount < 2) return warnings

  let negativeSteps = 0
  let duplicateSteps = 0
  const positive = new Float64Array(finiteCount - 1)
  let positiveCount = 0
  for (let index = 1; index < finiteCount; index++) {
    const difference = (finite[index] as number) - (finite[index - 1] as number)
    if (difference < 0) negativeSteps++
    else if (difference === 0) duplicateSteps++
    else positive[positiveCount++] = difference
  }

  if (negativeSteps > 0) {
    warnings.push(
      warning(
        'TIME_NOT_MONOTONIC',
        `The time axis steps backwards at ${negativeSteps} place(s); start detection and ` +
          'interpolation may pick unintended samples.',
        { count: negativeSteps },
      ),
    )
  }
  if (duplicateSteps > 0) {
    warnings.push(
      warning('TIME_DUPLICATE_TIMESTAMPS', `The time axis repeats ${duplicateSteps} timestamp(s).`, {
        count: duplicateSteps,
      }),
    )
  }

  if (positiveCount === 0) return warnings

  const sorted = positive.slice(0, positiveCount).sort()
  const medianStep = medianOfSorted(sorted)
  const configuredRate = Number(config.samplingRate)
  if (Number.isFinite(configuredRate) && configuredRate > 0 && medianStep > 0) {
    const observedRate = 1 / medianStep
    // More than 10% apart and the window sizes, which are specified in seconds,
    // no longer mean what the configuration says they mean.
    if (Math.abs(observedRate - configuredRate) / configuredRate > 0.1) {
      warnings.push(
        warning(
          'SAMPLING_RATE_MISMATCH',
          `The configured sampling rate (${configuredRate} Hz) disagrees with the data ` +
            `(${observedRate} Hz); analysis windows will not cover the intended duration.`,
          { configuredRate, observedRate },
        ),
      )
    }
  }

  const spread = percentileOfSorted(sorted, 0.95) - percentileOfSorted(sorted, 0.05)
  if (medianStep > 0 && spread / medianStep > 0.5) {
    warnings.push(
      warning(
        'SAMPLING_INTERVAL_UNEVEN',
        'Sample spacing is uneven; time-window statistics should be read as approximate.',
        { medianStep, spread },
      ),
    )
  }

  return warnings
}

interface SyncSearch {
  index: number
  count: number
}

/** `np.where(np.abs(x) < threshold)[0]` — first hit and how many there are. */
function findSyncCandidates(values: Float64Array, threshold: number): SyncSearch {
  let first = -1
  let count = 0
  for (let index = 0; index < values.length; index++) {
    // NaN fails the comparison, so a masked sample can never become a sync point.
    if (Math.abs(values[index] as number) < threshold) {
      if (first < 0) first = index
      count++
    }
  }
  return { index: first, count }
}

function readSensorColumn(
  table: CsvTable,
  columnName: string,
  warnings: AnalysisWarning[],
): Float64Array {
  const column = table.column(columnName) as CsvColumn
  const numeric = toNumericColumn(column)
  if (numeric.coercedCount > 0) warnings.push(coercionWarning(column, numeric.coercedCount))
  return numeric.values
}

/**
 * Load a parsed table into synchronised gravity series.
 *
 * Throws `ColumnNotFoundError` (carrying both the missing names and every
 * available column) when the configuration points at columns this file does not
 * have, which is the signal the UI answers by reopening column selection.
 */
export function loadAndProcessData(table: CsvTable, config: AnalysisConfig): LoadedData {
  const warnings: AnalysisWarning[] = []
  const useInner = config.useInnerAcceleration
  const useDrag = config.useDragAcceleration

  if (!useInner && !useDrag) {
    throw new DataProcessingError(
      'NO_SENSOR_ENABLED',
      'Both the Inner Capsule and the Drag Shield accelerometers are disabled; enable at least one.',
    )
  }

  const missingColumns: string[] = []
  if (!table.has(config.timeColumn)) missingColumns.push(config.timeColumn)
  if (useInner && !table.has(config.accelerationColumnInnerCapsule)) {
    missingColumns.push(config.accelerationColumnInnerCapsule)
  }
  if (useDrag && !table.has(config.accelerationColumnDragShield)) {
    missingColumns.push(config.accelerationColumnDragShield)
  }
  if (missingColumns.length > 0) throw new ColumnNotFoundError(missingColumns, table.columnNames)

  const timeColumn = table.column(config.timeColumn) as CsvColumn
  const timeNumeric = toNumericColumn(timeColumn)
  if (timeNumeric.coercedCount > 0) warnings.push(coercionWarning(timeColumn, timeNumeric.coercedCount))
  const time = timeNumeric.values
  warnings.push(...validateTimeAxis(time, config))

  const innerAcceleration = useInner
    ? readSensorColumn(table, config.accelerationColumnInnerCapsule, warnings)
    : EMPTY_SERIES
  const dragAcceleration = useDrag
    ? readSensorColumn(table, config.accelerationColumnDragShield, warnings)
    : EMPTY_SERIES

  // A sample with an unusable timestamp cannot be placed on the time axis, so
  // its acceleration is masked out. Deleting the row instead would compress the
  // axis and quietly redefine the window width; masking keeps the alignment and
  // has two consequences the reference relies on: |NaN| < threshold is false, so
  // the sample cannot be chosen as a sync point (which would make the whole
  // adjusted axis NaN), and any window containing it is incomplete and therefore
  // ineligible to win the minimum-standard-deviation search.
  let maskedCount = 0
  for (let index = 0; index < time.length; index++) {
    if (Number.isFinite(time[index] as number)) continue
    maskedCount++
    if (innerAcceleration.length > 0) innerAcceleration[index] = Number.NaN
    if (dragAcceleration.length > 0) dragAcceleration[index] = Number.NaN
  }
  if (maskedCount > 0) {
    warnings.push(
      warning(
        'TIME_ROWS_MASKED',
        `${maskedCount} row(s) have an unusable timestamp; their acceleration samples were ` +
          'treated as missing.',
        { count: maskedCount },
      ),
    )
  }

  if (useInner && config.invertInnerAcceleration) {
    for (let index = 0; index < innerAcceleration.length; index++) {
      innerAcceleration[index] = -(innerAcceleration[index] as number)
    }
  }

  const threshold = config.accelerationThreshold
  const dragSearch =
    useDrag && dragAcceleration.length > 0
      ? findSyncCandidates(dragAcceleration, threshold)
      : { index: -1, count: 0 }
  const innerSearch =
    useInner && innerAcceleration.length > 0
      ? findSyncCandidates(innerAcceleration, threshold)
      : { index: -1, count: 0 }

  let dragIndex = dragSearch.count > 0 ? dragSearch.index : 0
  let innerIndex = innerSearch.count > 0 ? innerSearch.index : 0
  let innerFallback: SyncFallback | null = null
  let dragFallback: SyncFallback | null = null

  if (useDrag && dragSearch.count === 0) {
    dragFallback = 'first-sample'
    warnings.push(
      warning('SYNC_POINT_NOT_FOUND', 'No Drag Shield sample fell below the sync threshold; using sample 0.', {
        sensor: 'drag',
      }),
    )
  }
  if (useInner && innerSearch.count === 0 && dragSearch.count > 0) {
    innerIndex = dragIndex
    innerFallback = 'borrowed-drag'
    warnings.push(
      warning(
        'SYNC_POINT_BORROWED',
        "No Inner Capsule sample fell below the sync threshold; the Drag Shield's sync point was used.",
        { sensor: 'inner', index: dragIndex },
      ),
    )
  } else if (useInner && innerSearch.count === 0) {
    innerFallback = 'first-sample'
    warnings.push(
      warning(
        'SYNC_POINT_NOT_FOUND',
        'No Inner Capsule sample fell below the sync threshold; using sample 0.',
        { sensor: 'inner' },
      ),
    )
  }

  const gravityConstant = config.gravityConstant
  if (gravityConstant === 0) {
    throw new DataProcessingError(
      'GRAVITY_CONSTANT_ZERO',
      'The gravity constant is zero, so acceleration cannot be converted to G.',
    )
  }

  const innerTime = useInner ? shiftTime(time, innerIndex) : EMPTY_SERIES
  const dragTime = useDrag ? shiftTime(time, dragIndex) : EMPTY_SERIES
  const innerGravity = useInner ? divide(innerAcceleration, gravityConstant) : EMPTY_SERIES
  const dragGravity = useDrag ? divide(dragAcceleration, gravityConstant) : EMPTY_SERIES

  return {
    inner: { time: innerTime, gravity: innerGravity },
    drag: { time: dragTime, gravity: dragGravity },
    sync: {
      innerIndex: useInner ? innerIndex : null,
      dragIndex: useDrag ? dragIndex : null,
      innerFallback,
      dragFallback,
      innerCandidateCount: innerSearch.count,
      dragCandidateCount: dragSearch.count,
    },
    sampleCount: time.length,
    warnings,
  }
}

/** `time - time.iloc[syncIndex]` */
function shiftTime(time: Float64Array, syncIndex: number): Float64Array {
  const origin = time[syncIndex] as number
  const shifted = new Float64Array(time.length)
  for (let index = 0; index < time.length; index++) shifted[index] = (time[index] as number) - origin
  return shifted
}

/** `acceleration / gravity_constant` */
function divide(values: Float64Array, divisor: number): Float64Array {
  const result = new Float64Array(values.length)
  for (let index = 0; index < values.length; index++) result[index] = (values[index] as number) / divisor
  return result
}

/** `np.where(values >= threshold)[0][0]`, or -1 when nothing qualifies. */
function firstIndexAtLeast(values: Float64Array, threshold: number, from = 0): number {
  for (let index = from; index < values.length; index++) {
    if ((values[index] as number) >= threshold) return index
  }
  return -1
}

export interface FilteredSensor {
  time: Float64Array
  gravity: Float64Array
  /** Index of the first retained sample in the unfiltered series; null when empty. */
  startIndex: number | null
  /** Index of the last retained sample in the unfiltered series; null when empty. */
  endIndex: number | null
}

export interface FilterResult {
  inner: FilteredSensor
  drag: FilteredSensor
  /** The later of the two end indices, or -1 when neither sensor has data. */
  endIndex: number
  warnings: AnalysisWarning[]
}

const EMPTY_FILTERED: FilteredSensor = {
  time: EMPTY_SERIES,
  gravity: EMPTY_SERIES,
  startIndex: null,
  endIndex: null,
}

/**
 * `filter_data` — trim each sensor to its microgravity segment.
 *
 * Per sensor: start at the first sample at or after its own t = 0; refuse to end
 * before `minSecondsAfterStart` has elapsed (the release transient itself
 * crosses the end level, and without this guard the segment would close
 * immediately); end at the first sample at or after that point whose gravity
 * reaches `endGravityLevel`, or at the last sample if it never does.
 */
export function filterData(loaded: LoadedData, config: AnalysisConfig): FilterResult {
  const warnings: AnalysisWarning[] = []
  const hasInner = loaded.inner.gravity.length > 0
  const hasDrag = loaded.drag.gravity.length > 0

  if (!hasInner && !hasDrag) {
    throw new DataProcessingError(
      'NO_SENSOR_DATA',
      'Neither the Inner Capsule nor the Drag Shield produced any acceleration data.',
    )
  }

  const lengths: number[] = []
  if (hasInner) lengths.push(loaded.inner.gravity.length)
  if (hasDrag) lengths.push(loaded.drag.gravity.length)
  const requiredLength = config.samplingRate * config.windowSize
  const shortest = Math.min(...lengths)
  if (shortest < requiredLength) {
    warnings.push(
      warning(
        'DATA_SHORTER_THAN_WINDOW',
        `The shortest series holds ${shortest} sample(s) but one analysis window needs ` +
          `${requiredLength}.`,
        { samples: shortest, required: requiredLength },
      ),
    )
  }

  const inner = filterSensor(loaded.inner, 'inner', hasInner, config, warnings)
  const drag = filterSensor(loaded.drag, 'drag', hasDrag, config, warnings)

  const endIndices = [inner.rawEndIndex, drag.rawEndIndex].filter((index) => index >= 0)
  const endIndex = endIndices.length > 0 ? Math.max(...endIndices) : -1

  return { inner: inner.filtered, drag: drag.filtered, endIndex, warnings }
}

function filterSensor(
  series: SensorSeries,
  sensor: SensorId,
  present: boolean,
  config: AnalysisConfig,
  warnings: AnalysisWarning[],
): { filtered: FilteredSensor; rawEndIndex: number } {
  if (!present) return { filtered: EMPTY_FILTERED, rawEndIndex: -1 }

  const { time, gravity } = series

  let startIndex = firstIndexAtLeast(time, 0)
  if (startIndex < 0) {
    startIndex = 0
    warnings.push(
      warning('START_INDEX_NOT_FOUND', `No ${sensor} sample sits at or after t = 0; starting at sample 0.`, {
        sensor,
      }),
    )
  }

  const minimumTime = (time[startIndex] as number) + config.minSecondsAfterStart
  let minIndex = firstIndexAtLeast(time, minimumTime)
  if (minIndex < 0) {
    minIndex = startIndex
    warnings.push(
      warning(
        'MIN_TIME_INDEX_NOT_FOUND',
        `No ${sensor} sample reaches ${config.minSecondsAfterStart} s after the start; using the ` +
          'start sample.',
        { sensor, minSecondsAfterStart: config.minSecondsAfterStart },
      ),
    )
  }

  let endIndex = firstIndexAtLeast(gravity, config.endGravityLevel, minIndex)
  if (endIndex < 0) {
    endIndex = gravity.length - 1
    warnings.push(
      warning(
        'END_LEVEL_NOT_REACHED',
        `The ${sensor} channel never reaches ${config.endGravityLevel} G; using the last sample.`,
        { sensor, endGravityLevel: config.endGravityLevel, index: endIndex },
      ),
    )
  }

  if (endIndex < startIndex) return { filtered: EMPTY_FILTERED, rawEndIndex: endIndex }

  // `slice` copies rather than viewing: a subarray would keep the whole source
  // buffer alive and drag it across the worker boundary on every postMessage.
  return {
    filtered: {
      time: time.slice(startIndex, endIndex + 1),
      gravity: gravity.slice(startIndex, endIndex + 1),
      startIndex,
      endIndex,
    },
    rawEndIndex: endIndex,
  }
}
