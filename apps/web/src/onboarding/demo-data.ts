/**
 * Deterministic demo data for the first-run live onboarding.
 *
 * The stage renders the real analysis components (`UPlotChart`,
 * `StatisticsPanel`, `RangeStatisticsPanel`, …), so it needs real `Dataset`
 * values rather than view fixtures. Synthesizing them here keeps the demo
 * offline, deterministic (seeded PRNG — same curve on every visit, which is
 * what makes the timeline's scripted selections meaningful), and free of any
 * fixture fetch.
 *
 * The numbers are real in the only sense that matters to a viewer: statistics
 * and G-quality rows are computed by `analysis-core` on the synthesized
 * series, not invented. What is fake is provenance — no CSV was parsed and no
 * worker ran.
 */

import { calculateStatistics, type GQualityRow } from '@aat/analysis-core'
import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import type { ColumnMapping } from '../analysis/protocol.ts'
import { asFullResolution, type FullResolutionArray } from '../analysis/series.ts'
import type { Dataset, SensorDataset } from '../app/dataset.ts'

const CONFIG = DEFAULT_ANALYSIS_CONFIG

/** mulberry32 — a tiny seeded PRNG so the "recording" is identical every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Approximately Gaussian noise via a summed uniform — smooth enough at 1 kHz. */
function gaussian(random: () => number): number {
  return random() + random() + random() - 1.5
}

interface SensorSpec {
  /** Gravity level before release (≈1 G holding the capsule). */
  restLevel: number
  /** Mean level during freefall. */
  freefallLevel: number
  /** Broadband noise σ during freefall (G). */
  noise: number
  /** Release-transient amplitude at t=0 (G). */
  transient: number
}

/**
 * One sensor's unfiltered and filtered series.
 *
 * Shape mimics a drop-tower run: a steady ~1 G hold, a short release
 * transient, then low-noise freefall. Time is the sensor's sync-adjusted axis:
 * unfiltered covers a little before and after the drop, filtered is the
 * microgravity window [0, duration).
 */
function synthesizeSensor(
  spec: SensorSpec,
  seed: number,
): {
  time: FullResolutionArray
  gravity: FullResolutionArray
  filteredTime: FullResolutionArray
  filteredGravity: FullResolutionArray
  acceleration: FullResolutionArray
  startIndex: number
  endIndex: number
} {
  const random = seededRandom(seed)
  const rate = CONFIG.sampling_rate
  const duration = CONFIG.default_graph_duration
  const preSeconds = 0.5
  const postSeconds = 0.5

  const total = Math.round((preSeconds + duration + postSeconds) * rate)
  const filteredCount = Math.round(duration * rate)
  const startIndex = Math.round(preSeconds * rate)

  const time = new Float64Array(total)
  const gravity = new Float64Array(total)
  const filteredTime = new Float64Array(filteredCount)
  const filteredGravity = new Float64Array(filteredCount)
  const acceleration = new Float64Array(total)

  // A slow wander plus white-ish noise reads as a real sensor, not a sine.
  let wander = 0
  for (let index = 0; index < total; index += 1) {
    const t = index / rate - preSeconds
    time[index] = t
    wander += gaussian(random) * 0.0004
    wander *= 0.999
    const release = Math.exp(-Math.max(0, t) * 30) * Math.sin(t * 140) * spec.transient
    const level = t < 0 ? spec.restLevel : spec.freefallLevel
    const value = level + release + wander + gaussian(random) * spec.noise
    gravity[index] = value
    acceleration[index] = value * CONFIG.gravity_constant
    const filteredIndex = index - startIndex
    if (filteredIndex >= 0 && filteredIndex < filteredCount) {
      filteredTime[filteredIndex] = t
      filteredGravity[filteredIndex] = value
    }
  }

  return {
    time: asFullResolution(time),
    gravity: asFullResolution(gravity),
    filteredTime: asFullResolution(filteredTime),
    filteredGravity: asFullResolution(filteredGravity),
    acceleration: asFullResolution(acceleration),
    startIndex,
    endIndex: startIndex + filteredCount - 1,
  }
}

function toSensorDataset(sensor: ReturnType<typeof synthesizeSensor>): SensorDataset {
  return {
    present: true,
    time: sensor.time,
    gravity: sensor.gravity,
    filteredTime: sensor.filteredTime,
    filteredGravity: sensor.filteredGravity,
    acceleration: sensor.acceleration,
    startIndex: sensor.startIndex,
    endIndex: sensor.endIndex,
  }
}

/**
 * The G-quality table, computed the same way the sweep computes it — the
 * minimum-standard-deviation window at each ladder size — but synchronously,
 * so the demo never awaits a worker.
 */
function gQualityRows(inner: SensorDataset, drag: SensorDataset): GQualityRow[] {
  const rows: GQualityRow[] = []
  const { g_quality_start: start, g_quality_end: end, g_quality_step: step } = CONFIG
  const statisticsOf = (sensor: SensorDataset, windowSize: number) =>
    calculateStatistics(sensor.filteredGravity, sensor.filteredTime, {
      windowSize,
      samplingRate: CONFIG.sampling_rate,
    })
  for (let windowSize = start; windowSize <= end + 1e-9; windowSize += step) {
    const innerStats = statisticsOf(inner, windowSize)
    const dragStats = statisticsOf(drag, windowSize)
    rows.push({
      windowSize: Number(windowSize.toFixed(6)),
      innerStartTime: innerStats.startTime,
      innerMean: innerStats.mean,
      innerStd: innerStats.std,
      dragStartTime: dragStats.startTime,
      dragMean: dragStats.mean,
      dragStd: dragStats.std,
    })
  }
  return rows
}

const MAPPING: ColumnMapping = {
  timeColumn: 'Time (s)',
  innerColumn: 'Z-axis acceleration 1(m/s2)',
  dragColumn: 'Z-axis acceleration 2(m/s2)',
  useInner: true,
  useDrag: true,
}

function buildDataset(filename: string, seed: number, innerSpec: SensorSpec, dragSpec: SensorSpec): Dataset {
  const inner = toSensorDataset(synthesizeSensor(innerSpec, seed))
  const drag = toSensorDataset(synthesizeSensor(dragSpec, seed + 1))
  const statisticsConfig = { windowSize: CONFIG.window_size, samplingRate: CONFIG.sampling_rate }
  const sampleCount = inner.time.length
  return {
    name: filename.replace(/\.csv$/i, ''),
    filename,
    sourceSha256: `demo-${seed.toString(16)}`,
    encoding: 'utf-8',
    columnNames: [MAPPING.timeColumn, MAPPING.innerColumn, MAPPING.dragColumn],
    mapping: MAPPING,
    inner,
    drag,
    sync: {
      innerIndex: inner.startIndex,
      dragIndex: drag.startIndex,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 240,
      dragCandidateCount: 226,
    },
    filterEndIndex: Math.max(inner.endIndex ?? -1, drag.endIndex ?? -1),
    statistics: {
      inner: calculateStatistics(inner.filteredGravity, inner.filteredTime, statisticsConfig),
      drag: calculateStatistics(drag.filteredGravity, drag.filteredTime, statisticsConfig),
    },
    gQuality: gQualityRows(inner, drag),
    gQualityComputed: true,
    warnings: [],
    sampleCount,
    analysisTimestamp: '2026-01-16T09:30:00.000Z',
    fromCache: false,
    config: CONFIG,
  }
}

/**
 * The two datasets the demo plays with: the drop of
 * `normal_two_sensor_utf8.csv` (mirroring the public fixture's name and
 * column headers), then `comparison_b.csv` joining for the compare step.
 */
export function buildDemoDatasets(): readonly Dataset[] {
  return [
    buildDataset(
      'normal_two_sensor_utf8.csv',
      0xa17a,
      { restLevel: 0.98, freefallLevel: 0.0035, noise: 0.0085, transient: 0.14 },
      { restLevel: 1.02, freefallLevel: -0.005, noise: 0.016, transient: 0.22 },
    ),
    buildDataset(
      'comparison_b.csv',
      0x5eed,
      { restLevel: 0.97, freefallLevel: -0.002, noise: 0.011, transient: 0.18 },
      { restLevel: 1.01, freefallLevel: 0.004, noise: 0.019, transient: 0.26 },
    ),
  ]
}
