/**
 * Reopening a stored analysis: an `AnalysisSnapshot` back into the `Dataset` the analyzer draws.
 *
 * This module is the reason the Run Gallery is not a picture gallery. `packages/shared/snapshot.ts`
 * says what a snapshot is for in its first paragraph — "everything needed to replay a run's graph,
 * recompute user-selected-range statistics, regenerate its Excel export and build a custom poster,
 * without needing the original source CSV ever again" — and the only way to make good on that
 * without writing a second renderer is to land the snapshot on the exact type the first renderer
 * already consumes. So the output here is `Dataset`, unchanged, and every downstream path is the
 * analyzer's own: `buildPlotModel` and `UPlotChart` draw it, `SelectionOverlay` and
 * `rangeStatisticsFor` select and measure over it, `workbookInputFor` and `ExportClient` export it,
 * and `buildPosterPlotSpec` turns a selection into a formal figure.
 *
 * ## Full resolution survives the round trip, exactly
 *
 * A snapshot's series are base64 of little-endian `Float64Array` bytes, which is exact for every
 * IEEE-754 pattern including NaN gaps and −0, and they are never downsampled. So the arrays that
 * come out of `decodeSeries` are the arrays that went in, sample for sample, and marking them with
 * `asFullResolution` here is a true promise rather than a convenient one. `series.ts` names this as
 * one of exactly two places the brand may be minted — the analysis worker boundary and the snapshot
 * decoder — and this is that decoder.
 *
 * ## What the format does not carry, and how that is handled
 *
 * A snapshot is an analytical record, not a copy of the analyzer's session state, so three fields
 * of `Dataset` have no source in it. None is faked silently:
 *
 *  - **Warning messages.** `warnings` in the snapshot is a list of stable *codes*; the English
 *    sentences are produced by `@aat/analysis-core` at analysis time and are not stored. Rather
 *    than casting a `string` into `AnalysisWarningCode` and inventing a message to sit beside it,
 *    the replayed `Dataset.warnings` is empty and the codes are returned alongside it, where the
 *    detail screen renders them as codes.
 *  - **The source encoding.** Not recorded. The placeholder below is never displayed by anything
 *    that replays a snapshot, and `sourceEncodingKnown` is false so no caller can mistake it.
 *  - **Which sync fallback fired.** The snapshot records a fallback *index*, not which of the two
 *    strategies produced it — `cloud/sync.ts` reduced `'borrowed-drag' | 'first-sample'` to a
 *    number on the way in. The warning codes recover it: `SYNC_POINT_BORROWED` is only ever raised
 *    for the Inner Capsule borrowing the Drag Shield's point, so its presence identifies that case
 *    and its absence leaves `first-sample`, which is the only other way a fallback happens.
 */

import type { AnalysisWarning, GQualityRow, SyncFallback, SyncResult } from '@aat/analysis-core'
import {
  type AnalysisConfig,
  type AnalysisSnapshot,
  decodeScalar,
  decodeSeries,
  decodeSnapshot,
  gzipDecompress,
} from '@aat/shared'
import type { ColumnMapping } from '../analysis/protocol.ts'
import { asFullResolution } from '../analysis/series.ts'
import { type Dataset, datasetNameFromFilename, type SensorDataset } from '../app/dataset.ts'

/** A refusal a screen can render, rather than a `ZodError` or a `TypeError` from a decoder. */
export class SnapshotReplayError extends Error {
  readonly reason: 'not_gzip' | 'malformed' | 'unsupported_version'

  constructor(reason: SnapshotReplayError['reason'], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SnapshotReplayError'
    this.reason = reason
  }
}

/** The two bytes every gzip member starts with (RFC 1952 §2.3.1). */
const GZIP_MAGIC = [0x1f, 0x8b] as const

/**
 * Turn the bytes of `GET /revisions/:id/snapshot` into a validated snapshot.
 *
 * The gzip sniff is not a guess dressed up as a heuristic — it is the only signal available.
 * `PUT /revisions/:id/snapshot` stores `.json` or `.json.gz` according to its `format` parameter
 * but records `content_type: application/json` for both, and `streamObject` sets no
 * `content-encoding`, so neither the response headers nor the revision row distinguishes them.
 * Two bytes at the head of a document whose plain form always begins `{` is an unambiguous
 * discriminator: `0x1f 0x8b` cannot open a JSON document.
 *
 * Validation is `decodeSnapshot`, which re-checks the whole document against the Zod schema. A
 * snapshot that was corrupted in storage fails here, loudly, rather than becoming a plausible
 * graph of the wrong numbers.
 */
export async function decodeSnapshotBytes(bytes: Uint8Array): Promise<AnalysisSnapshot> {
  let json = bytes
  if (bytes.length >= 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]) {
    try {
      json = await gzipDecompress(bytes)
    } catch (error) {
      throw new SnapshotReplayError(
        'not_gzip',
        'スナップショットを展開できませんでした。保存されたデータが壊れている可能性があります。',
        error,
      )
    }
  }

  try {
    return decodeSnapshot(json)
  } catch (error) {
    // `snapshotFormatVersion` is a `z.literal`, so a document from a future format fails the same
    // parse as a corrupt one. Separating them lets the screen offer the right next step: "update
    // the application" is useful advice, "the data is damaged" is not.
    const looksVersioned = /snapshotFormatVersion/.test(error instanceof Error ? error.message : '')
    throw new SnapshotReplayError(
      looksVersioned ? 'unsupported_version' : 'malformed',
      looksVersioned
        ? 'このスナップショットは、このバージョンのAATが読める形式ではありません。アプリケーションを更新してください。'
        : 'スナップショットを読み込めませんでした。保存されたデータが壊れている可能性があります。',
      error,
    )
  }
}

/** One sensor's arrays, all branded full resolution because the snapshot is never downsampled. */
function sensorFrom(
  time: Float64Array,
  gravity: Float64Array,
  acceleration: Float64Array,
  filteredTime: Float64Array,
  filteredGravity: Float64Array,
  startIndex: number | null,
  endIndex: number | null,
): SensorDataset {
  return {
    // The snapshot writes every series for both sensors, zero-length for a sensor the run did not
    // use, so presence is "has samples" rather than "has a field" — which is exactly the branch the
    // format's own documentation asks callers to make.
    present: gravity.length > 0,
    time: asFullResolution(time),
    gravity: asFullResolution(gravity),
    filteredTime: asFullResolution(filteredTime),
    filteredGravity: asFullResolution(filteredGravity),
    acceleration: asFullResolution(acceleration),
    startIndex,
    endIndex,
  }
}

function statisticsFrom(value: AnalysisSnapshot['statistics']['inner']): Dataset['statistics']['inner'] {
  return {
    mean: decodeScalar(value.mean),
    startTime: decodeScalar(value.startTime),
    std: decodeScalar(value.std),
  }
}

function gQualityFrom(rows: AnalysisSnapshot['gQuality']): GQualityRow[] {
  return rows.map((row) => ({
    windowSize: row.windowSize,
    innerStartTime: decodeScalar(row.innerStartTime),
    innerMean: decodeScalar(row.innerMean),
    innerStd: decodeScalar(row.innerStd),
    dragStartTime: decodeScalar(row.dragStartTime),
    dragMean: decodeScalar(row.dragMean),
    dragStd: decodeScalar(row.dragStd),
  }))
}

/**
 * Rebuild the column mapping from `detectedColumns`.
 *
 * `cloud/sync.ts` writes `time: [timeColumn]` and `acceleration: [innerColumn, dragColumn]`, so
 * this is its inverse and not an interpretation of the general `DetectedColumns` shape. Used for
 * display only — nothing in the replay path reads a column name, because the samples are already
 * parsed.
 */
function mappingFrom(snapshot: AnalysisSnapshot, hasInner: boolean, hasDrag: boolean): ColumnMapping {
  const { time, acceleration } = snapshot.detectedColumns
  return {
    timeColumn: time[0] ?? '',
    innerColumn: acceleration[0] ?? '',
    dragColumn: acceleration[1] ?? '',
    useInner: hasInner,
    useDrag: hasDrag,
  }
}

/** See the module doc: the codes recover which fallback strategy fired. */
function syncFrom(snapshot: AnalysisSnapshot): SyncResult {
  const borrowed = snapshot.warnings.includes('SYNC_POINT_BORROWED')
  const innerFallback: SyncFallback | null =
    snapshot.sync.innerFallback === null ? null : borrowed ? 'borrowed-drag' : 'first-sample'
  return {
    innerIndex: snapshot.sync.innerIndex,
    dragIndex: snapshot.sync.dragIndex,
    innerFallback,
    // The Drag Shield never borrows: it is the sensor that gets borrowed from.
    dragFallback: snapshot.sync.dragFallback === null ? null : 'first-sample',
    innerCandidateCount: snapshot.sync.innerCandidateCount,
    dragCandidateCount: snapshot.sync.dragCandidateCount,
  }
}

/**
 * A replayed analysis: the dataset the analyzer's own components consume, plus the parts of the
 * record that have no place on `Dataset`.
 */
export interface ReplayedAnalysis {
  dataset: Dataset
  /**
   * The configuration the analysis was performed with — **not** the reader's current settings.
   *
   * This is load-bearing rather than tidy. `ylim_min`/`ylim_max` and `default_graph_duration` frame
   * the graph, and `sampling_rate` is the resampling rate of the Excel export's unified time axis.
   * Reading them from `localStorage` would mean a colleague who changed their own axis limits last
   * week reopens a two-year-old measurement and sees a different figure and exports a different
   * spreadsheet from the person who recorded it. The snapshot carries the config for this exact
   * reason, and the replay honours it.
   */
  config: AnalysisConfig
  /** Stable warning codes raised at analysis time. See the module doc for why not `AnalysisWarning`. */
  warningCodes: readonly string[]
  /** False, always: the format does not record the source CSV's character encoding. */
  sourceEncodingKnown: boolean
  /** The record itself, for the provenance panel. */
  snapshot: AnalysisSnapshot
}

/**
 * Land a snapshot on `Dataset`.
 *
 * The series mapping is the inverse of `cloud/sync.ts`, including the one pairing that does not
 * read the way it looks: the snapshot's `filteredTime` is the **Inner Capsule's** filtered axis and
 * `filteredAdjustedTime` is the **Drag Shield's**. Both names date from the desktop application,
 * where the two arrays were `filtered_time` and `filtered_adjusted_time` on one object; they are
 * two sensors' axes, not a raw and an adjusted version of one. Getting this backwards would draw
 * each sensor's samples against the other's time base — a graph that looks entirely reasonable and
 * is wrong by however far the two sync points differ.
 */
export function replayFromSnapshot(snapshot: AnalysisSnapshot): ReplayedAnalysis {
  const series = snapshot.series
  const innerTime = decodeSeries(series.innerAdjustedTime)
  const dragTime = decodeSeries(series.dragAdjustedTime)
  const innerGravity = decodeSeries(series.innerGravity)
  const dragGravity = decodeSeries(series.dragGravity)

  const inner = sensorFrom(
    innerTime,
    innerGravity,
    decodeSeries(series.innerAcceleration),
    decodeSeries(series.filteredTime),
    decodeSeries(series.filteredInnerGravity),
    snapshot.filter.innerStartIndex,
    snapshot.filter.innerEndIndex,
  )
  const drag = sensorFrom(
    dragTime,
    dragGravity,
    decodeSeries(series.dragAcceleration),
    decodeSeries(series.filteredAdjustedTime),
    decodeSeries(series.filteredDragGravity),
    snapshot.filter.dragStartIndex,
    snapshot.filter.dragEndIndex,
  )

  const dataset: Dataset = {
    name: datasetNameFromFilename(snapshot.originalFilename),
    filename: snapshot.originalFilename,
    sourceSha256: snapshot.sourceSha256,
    // Placeholder. See the module doc — `sourceEncodingKnown` is false and no replay screen shows
    // this field, because the snapshot format does not record it.
    encoding: 'utf-8',
    columnNames: [...snapshot.detectedColumns.time, ...snapshot.detectedColumns.acceleration],
    mapping: mappingFrom(snapshot, inner.present, drag.present),
    inner,
    drag,
    sync: syncFrom(snapshot),
    // -1 is how the engine spells "neither sensor had data"; null is how the snapshot spells it.
    filterEndIndex: snapshot.filter.endIndex ?? -1,
    statistics: {
      inner: statisticsFrom(snapshot.statistics.inner),
      drag: statisticsFrom(snapshot.statistics.drag),
    },
    gQuality: gQualityFrom(snapshot.gQuality),
    gQualityComputed: snapshot.gQuality.length > 0,
    // Empty by design, not by omission — see the module doc.
    warnings: [] as readonly AnalysisWarning[],
    // Rows in the source table: the adjusted-time series carries one entry per row of the file, so
    // the longer of the two sensors' axes is the row count even when one sensor was unused.
    sampleCount: Math.max(innerTime.length, dragTime.length),
    analysisTimestamp: snapshot.analysisTimestamp,
    // The bytes came from the cloud, not from the local IndexedDB cache. Saying "キャッシュ" here
    // would attribute the data to a store that was never consulted.
    fromCache: false,
  }

  return {
    dataset,
    config: snapshot.config,
    warningCodes: snapshot.warnings,
    sourceEncodingKnown: false,
    snapshot,
  }
}
