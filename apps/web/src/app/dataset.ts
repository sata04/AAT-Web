/**
 * The main thread's view of an analysed file.
 *
 * This is where worker output crosses into full-resolution territory: the
 * payload's plain `Float64Array`s are marked with {@link asFullResolution}
 * exactly once, here, because this is the one place where the promise ("these
 * are every original sample") is actually true. Everything downstream inherits
 * the brand instead of minting it.
 */

import type { AnalysisWarning, GQualityRow, SyncResult, WindowStatistics } from '@aat/analysis-core'
import type { AnalysisConfig } from '@aat/shared'
import type { AnalysisPayload, ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import { asFullResolution, type FullResolutionArray } from '../analysis/series.ts'

export interface SensorDataset {
  readonly present: boolean
  /** Sync-adjusted time for every row of the file. */
  readonly time: FullResolutionArray
  readonly gravity: FullResolutionArray
  /** The microgravity segment only — what the desktop calls the filtered data. */
  readonly filteredTime: FullResolutionArray
  readonly filteredGravity: FullResolutionArray
  /** Full-length acceleration in m/s^2 on this sensor's sync-adjusted axis. */
  readonly acceleration: FullResolutionArray
  /** Index of the first retained sample in the unfiltered series; null when empty. */
  readonly startIndex: number | null
  /** Index of the last retained sample in the unfiltered series; null when empty. */
  readonly endIndex: number | null
}

export interface Dataset {
  /** Display name: the filename without its extension, as the desktop keys on. */
  readonly name: string
  readonly filename: string
  readonly sourceSha256: string
  readonly encoding: 'utf-8' | 'shift_jis'
  readonly columnNames: readonly string[]
  readonly mapping: ColumnMapping
  readonly inner: SensorDataset
  readonly drag: SensorDataset
  readonly sync: SyncResult
  /** The later of the two sensors' end indices, or -1 when neither had data. */
  readonly filterEndIndex: number
  readonly statistics: { readonly inner: WindowStatistics; readonly drag: WindowStatistics }
  readonly gQuality: readonly GQualityRow[]
  readonly gQualityComputed: boolean
  readonly warnings: readonly AnalysisWarning[]
  readonly sampleCount: number
  readonly analysisTimestamp: string
  readonly fromCache: boolean
  /**
   * The configuration these numbers were produced under. `state.config` in the screen is the
   * *next* analysis's configuration — they differ during a settings-change re-analysis, and a
   * dataset whose re-run failed keeps its old config permanently. Anything written alongside
   * the numbers (an export's time axis, a synced revision's identity) must key off this, not the
   * live one.
   */
  readonly config: AnalysisConfig
}

/** `os.path.splitext(os.path.basename(path))[0]` — the desktop's dataset key. */
export function datasetNameFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function toSensorDataset(sensor: AnalysisPayload['inner']): SensorDataset {
  return {
    present: sensor.present,
    time: asFullResolution(sensor.time),
    gravity: asFullResolution(sensor.gravity),
    filteredTime: asFullResolution(sensor.filteredTime),
    filteredGravity: asFullResolution(sensor.filteredGravity),
    acceleration: asFullResolution(sensor.acceleration),
    startIndex: sensor.startIndex,
    endIndex: sensor.endIndex,
  }
}

export function datasetFromPayload(
  payload: AnalysisPayload,
  config: AnalysisConfig,
  fromCache: boolean,
): Dataset {
  return {
    name: datasetNameFromFilename(payload.filename),
    filename: payload.filename,
    sourceSha256: payload.sourceSha256,
    encoding: payload.encoding,
    columnNames: payload.columnNames,
    mapping: payload.mapping,
    inner: toSensorDataset(payload.inner),
    drag: toSensorDataset(payload.drag),
    sync: payload.sync,
    filterEndIndex: payload.filterEndIndex,
    statistics: payload.statistics,
    gQuality: payload.gQuality,
    gQualityComputed: payload.gQualityComputed,
    warnings: payload.warnings,
    sampleCount: payload.sampleCount,
    analysisTimestamp: payload.analysisTimestamp,
    fromCache,
    config,
  }
}

/**
 * Reconstruct the `OpenedSource` a dataset came from.
 *
 * Used to re-analyse an already-open file — after a settings change, or when
 * the worker's bounded table cache has evicted it — without making the user
 * drop the CSV again. `detected` is left empty on purpose: the only consumer
 * that reads it is the column dialog, which merges it with `columnNames`, and
 * column detection cannot produce a new answer for the same bytes anyway.
 */
export function openedSourceForDataset(dataset: Dataset): OpenedSource {
  return {
    sourceSha256: dataset.sourceSha256,
    filename: dataset.filename,
    encoding: dataset.encoding,
    columnNames: [...dataset.columnNames],
    detected: { time: [], acceleration: [] },
    rowCount: dataset.sampleCount,
    suggestedMapping: dataset.mapping,
    ambiguity: null,
  }
}

export type SensorMode = 'both' | 'inner_only' | 'drag_only'

/**
 * Narrow a stored `graph_sensor_mode` to the union.
 *
 * Same reason as `themeSettingFrom`: the shared schema validates the value at
 * runtime but its inferred type is `string`. `both` is the default and the only
 * safe fallback — showing everything can mislead nobody.
 */
export function sensorModeFrom(value: string): SensorMode {
  return value === 'inner_only' || value === 'drag_only' ? value : 'both'
}

/**
 * `MainWindow._resolve_sensor_visibility`.
 *
 * The fallbacks matter: asking for Inner-only on a file that has no Inner
 * Capsule data shows the Drag Shield rather than an empty graph. Silence would
 * read as "the run was flat", which is the opposite of the truth.
 */
export function resolveSensorVisibility(
  mode: SensorMode,
  hasInner: boolean,
  hasDrag: boolean,
): { showInner: boolean; showDrag: boolean } {
  let showInner = hasInner && (mode === 'both' || mode === 'inner_only')
  let showDrag = hasDrag && (mode === 'both' || mode === 'drag_only')

  if (mode === 'inner_only' && !showInner && hasDrag) showDrag = true
  if (mode === 'drag_only' && !showDrag && hasInner) showInner = true
  if (!showInner && !showDrag) showInner = hasInner

  return { showInner, showDrag }
}

/** Whether a sensor has anything to draw in the filtered (normal) view. */
export function hasFilteredData(sensor: SensorDataset): boolean {
  return sensor.filteredGravity.length > 0
}

/** Whether a sensor has anything to draw in the show-all view. */
export function hasAllData(sensor: SensorDataset): boolean {
  return sensor.gravity.length > 0
}
