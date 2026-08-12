/**
 * Building analysis snapshots for the upload tests.
 *
 * The Worker validates every uploaded snapshot by decoding it against @aat/shared's schema and
 * cross-checking it against the revision it is filed under, so the tests have to produce genuinely
 * valid snapshots rather than opaque bytes. That is the point: an upload path that accepts
 * anything is not storing an analytical record, it is storing a blob.
 */

import {
  type AnalysisSnapshot,
  DEFAULT_ANALYSIS_CONFIG,
  encodeSeries,
  encodeSnapshot,
  SNAPSHOT_FORMAT_VERSION,
  sha256Hex,
} from '@aat/shared'

const EMPTY = encodeSeries(new Float64Array(0))

export interface SnapshotOptions {
  sourceSha256: string
  configHash: string
  /** Pads the snapshot with filler so a test can aim at a byte size. */
  paddingBytes?: number
}

export function buildSnapshot(options: SnapshotOptions): AnalysisSnapshot {
  const time = encodeSeries(new Float64Array([0, 0.001, 0.002, 0.003]))
  const gravity = encodeSeries(new Float64Array([0.0001, 0.0002, 0.00015, 0.0001]))

  return {
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    analysisEngineVersion: '1.0.0',
    appVersion: '1.0.0',
    sourceSha256: options.sourceSha256,
    originalFilename: '260811a_data.csv',
    config: { ...DEFAULT_ANALYSIS_CONFIG },
    configHash: options.configHash,
    detectedColumns: { time: ['Time'], acceleration: ['Inner', 'Drag'] },
    sync: {
      innerIndex: 12,
      dragIndex: 14,
      innerFallback: null,
      dragFallback: null,
      innerCandidateCount: 1,
      dragCandidateCount: 1,
    },
    filter: {
      endIndex: 3,
      innerLength: 4,
      dragLength: 4,
      innerStartIndex: 0,
      innerEndIndex: 3,
      dragStartIndex: 0,
      dragEndIndex: 3,
    },
    // Padding lives in `warnings` because it is the one field that is a free-form string list, so
    // the padded snapshot is still a schema-valid snapshot rather than a deliberately broken one.
    warnings: options.paddingBytes ? ['x'.repeat(options.paddingBytes)] : [],
    series: {
      innerAdjustedTime: time,
      dragAdjustedTime: time,
      innerGravity: gravity,
      dragGravity: gravity,
      innerAcceleration: gravity,
      dragAcceleration: gravity,
      filteredTime: time,
      filteredAdjustedTime: time,
      filteredInnerGravity: gravity,
      filteredDragGravity: gravity,
    },
    statistics: {
      inner: { mean: 0.0001, startTime: 1.2, std: 0.00002 },
      drag: { mean: 'NaN', startTime: null, std: null },
    },
    gQuality: [],
    provenance: { source: 'csv_upload' },
    analysisTimestamp: new Date().toISOString(),
  } satisfies AnalysisSnapshot & { series: { innerAdjustedTime: typeof EMPTY } }
}

export interface EncodedSnapshot {
  bytes: Uint8Array
  sha256: string
}

export async function encodeForUpload(snapshot: AnalysisSnapshot): Promise<EncodedSnapshot> {
  const bytes = encodeSnapshot(snapshot)
  return { bytes, sha256: await sha256Hex(bytes) }
}
