/**
 * Turning a local analysis into a cloud snapshot.
 *
 * The snapshot is the durable record: it carries every full-resolution series
 * needed to redraw the graph, recompute a range statistic and rebuild the Excel
 * sheets, plus the configuration and the engine version that produced them. That
 * is what makes a published figure traceable years later, and it is why the
 * series go in at full resolution — a decimated snapshot would be a picture, not
 * a record.
 *
 * Nothing here is required for the application to work. If it never runs, the
 * user still has the analysis, the graph and the exports.
 */

import type { WindowStatistics } from '@aat/analysis-core'
import {
  type AnalysisConfig,
  type AnalysisSnapshot,
  configHash,
  encodeScalar,
  encodeSeries,
  encodeSnapshot,
  gzipCompress,
  SNAPSHOT_FORMAT_VERSION,
} from '@aat/shared'
import type { Dataset } from '../app/dataset.ts'
import { ANALYSIS_ENGINE_VERSION, APP_VERSION } from '../app/version.ts'
import { type CloudOutcome, type SnapshotUploadResult, uploadSnapshot } from './gateway.ts'

function statistics(value: WindowStatistics): AnalysisSnapshot['statistics']['inner'] {
  return {
    mean: encodeScalar(value.mean),
    startTime: encodeScalar(value.startTime),
    std: encodeScalar(value.std),
  }
}

/**
 * Build the snapshot document for a dataset.
 *
 * `innerFallback` / `dragFallback` become the sample index that was actually
 * used when the threshold search found nothing, which is what the schema asks
 * for — the *reason* for the fallback is already in the warnings list, and
 * recording it twice in two shapes would let the two disagree.
 */
export async function buildSnapshot(dataset: Dataset, config: AnalysisConfig): Promise<AnalysisSnapshot> {
  return {
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    analysisEngineVersion: ANALYSIS_ENGINE_VERSION,
    appVersion: APP_VERSION,
    sourceSha256: dataset.sourceSha256,
    originalFilename: dataset.filename,
    config,
    configHash: await configHash(config),
    detectedColumns: {
      time: [dataset.mapping.timeColumn],
      acceleration: [dataset.mapping.innerColumn, dataset.mapping.dragColumn],
    },
    sync: {
      innerIndex: dataset.sync.innerIndex,
      dragIndex: dataset.sync.dragIndex,
      innerFallback: dataset.sync.innerFallback === null ? null : (dataset.sync.innerIndex ?? 0),
      dragFallback: dataset.sync.dragFallback === null ? null : (dataset.sync.dragIndex ?? 0),
      innerCandidateCount: dataset.sync.innerCandidateCount,
      dragCandidateCount: dataset.sync.dragCandidateCount,
    },
    filter: {
      // -1 means "neither sensor had data" in the engine; null is how the
      // snapshot format spells the same thing.
      endIndex: dataset.filterEndIndex >= 0 ? dataset.filterEndIndex : null,
      innerLength: dataset.inner.filteredGravity.length,
      dragLength: dataset.drag.filteredGravity.length,
      innerStartIndex: dataset.inner.startIndex,
      innerEndIndex: dataset.inner.endIndex,
      dragStartIndex: dataset.drag.startIndex,
      dragEndIndex: dataset.drag.endIndex,
    },
    warnings: dataset.warnings.map((warning) => warning.code),
    series: {
      innerAdjustedTime: encodeSeries(dataset.inner.time),
      dragAdjustedTime: encodeSeries(dataset.drag.time),
      innerGravity: encodeSeries(dataset.inner.gravity),
      dragGravity: encodeSeries(dataset.drag.gravity),
      innerAcceleration: encodeSeries(dataset.inner.acceleration),
      dragAcceleration: encodeSeries(dataset.drag.acceleration),
      filteredTime: encodeSeries(dataset.inner.filteredTime),
      filteredAdjustedTime: encodeSeries(dataset.drag.filteredTime),
      filteredInnerGravity: encodeSeries(dataset.inner.filteredGravity),
      filteredDragGravity: encodeSeries(dataset.drag.filteredGravity),
    },
    statistics: {
      inner: statistics(dataset.statistics.inner),
      drag: statistics(dataset.statistics.drag),
    },
    gQuality: dataset.gQuality.map((row) => ({
      windowSize: row.windowSize,
      innerStartTime: encodeScalar(row.innerStartTime),
      innerMean: encodeScalar(row.innerMean),
      innerStd: encodeScalar(row.innerStd),
      dragStartTime: encodeScalar(row.dragStartTime),
      dragMean: encodeScalar(row.dragMean),
      dragStd: encodeScalar(row.dragStd),
    })),
    provenance: { source: 'csv_upload', uploadedAt: new Date().toISOString() },
    analysisTimestamp: dataset.analysisTimestamp,
  }
}

/**
 * Encode, compress and upload.
 *
 * Gzip because these documents are mostly base64 of slowly varying floats, which
 * compresses well, and because the upload is the one part of this that a
 * researcher on a conference network will notice.
 */
export async function syncDataset(
  dataset: Dataset,
  config: AnalysisConfig,
): Promise<CloudOutcome<SnapshotUploadResult>> {
  const snapshot = await buildSnapshot(dataset, config)
  const encoded = encodeSnapshot(snapshot)
  const compressed = await gzipCompress(encoded)
  return uploadSnapshot(compressed, {
    sourceSha256: dataset.sourceSha256,
    configHash: snapshot.configHash,
    filename: dataset.filename,
  })
}
