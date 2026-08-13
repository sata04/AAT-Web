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
  parseRunFilename,
  SNAPSHOT_FORMAT_VERSION,
  sha256Hex,
} from '@aat/shared'
import type { Dataset } from '../app/dataset.ts'
import { ANALYSIS_ENGINE_VERSION, APP_VERSION } from '../app/version.ts'
import {
  type CloudOutcome,
  createRevision,
  createRun,
  type RevisionMetrics,
  uploadSnapshot,
} from './gateway.ts'

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
 * The headline numbers `analysis_metrics` denormalises out of the snapshot.
 *
 * They are a convenience for the gallery, not a second source of truth: the
 * snapshot in R2 remains the analytical record, and every value here is read
 * back out of it. The G-quality sweep is *omitted* rather than truncated when it
 * is longer than the route accepts — a partial sweep filed under the same name
 * as a complete one is a lie the gallery would repeat, and the full sweep is in
 * the snapshot either way.
 */
const MAX_METRIC_G_QUALITY_ROWS = 1000

function metricsFor(dataset: Dataset, config: AnalysisConfig): RevisionMetrics {
  const gQuality =
    dataset.gQuality.length > MAX_METRIC_G_QUALITY_ROWS
      ? undefined
      : dataset.gQuality.map((row) => ({
          windowSize: row.windowSize,
          innerStartTime: encodeScalar(row.innerStartTime),
          innerMean: encodeScalar(row.innerMean),
          innerStd: encodeScalar(row.innerStd),
          dragStartTime: encodeScalar(row.dragStartTime),
          dragMean: encodeScalar(row.dragMean),
          dragStd: encodeScalar(row.dragStd),
        }))

  return {
    windowSize: config.window_size,
    inner: {
      mean: encodeScalar(dataset.statistics.inner.mean),
      std: encodeScalar(dataset.statistics.inner.std),
      startTime: encodeScalar(dataset.statistics.inner.startTime),
    },
    drag: {
      mean: encodeScalar(dataset.statistics.drag.mean),
      std: encodeScalar(dataset.statistics.drag.std),
      startTime: encodeScalar(dataset.statistics.drag.startTime),
    },
    // The filtered segment is what the statistics were computed over, so it is
    // the count that explains them. The unfiltered row count is in the snapshot.
    innerSampleCount: dataset.inner.filteredGravity.length,
    dragSampleCount: dataset.drag.filteredGravity.length,
    warningCount: dataset.warnings.length,
    ...(gQuality === undefined ? {} : { gQuality }),
  }
}

/** Everything the analyzer needs to keep working with a synced analysis. */
export interface CloudSyncResult {
  runId: string
  /** Six digits and an optional suffix letter. Also the poster spec's `runCode`. */
  runCode: string
  revisionId: string
  /** False when this exact analysis had already been stored — a retry, or a second device. */
  revisionCreated: boolean
  /**
   * Compressed snapshot size, for the status line, or null when nothing was uploaded because the
   * revision already carried its snapshot. Null is "already stored", never "stored zero bytes".
   */
  snapshotBytes: number | null
}

/**
 * A refusal this module makes itself, in the same shape the gateway produces.
 *
 * The only one there is: a filename that does not carry a run code. The Worker
 * cannot record an experiment without one, and neither can a poster spec, so
 * discovering it here — before three requests have been made — is both cheaper
 * and clearer than relaying `run_code_required` back from the server.
 */
function refuse(message: string): CloudOutcome<never> {
  return { ok: false, kind: 'error', code: 'INVALID_ANALYSIS_CONFIG', message, retryable: false }
}

/**
 * Store an analysis in the cloud: run, then revision, then snapshot.
 *
 * Three requests, in that order, because that is the shape the Worker serves and
 * because each one is the thing the next one hangs from. All three are safe to
 * repeat:
 *
 *  - `POST /runs` is refused for a run code the caller already owns, and the
 *    refusal names the existing run — so a second analysis of the same drop
 *    becomes a second *revision*, which is what the data model means by "same
 *    capsule drop, different settings".
 *  - `POST /runs/:runId/revisions` is keyed on `(source bytes, config, engine)`,
 *    so re-analysing identical bytes with identical settings returns the
 *    revision that exists rather than minting a duplicate.
 *  - `PUT /revisions/:id/snapshot` answers a byte-identical re-upload
 *    idempotently, and refuses *different* bytes for a revision that already has
 *    a snapshot.
 *
 * Gzip because these documents are mostly base64 of slowly varying floats, which
 * compresses well, and because the upload is the one part of this that a
 * researcher on a conference network will notice.
 *
 * Nothing here is required for the application to work. If every call fails, the
 * user still has the analysis, the graph and the exports.
 */
export async function syncDataset(
  dataset: Dataset,
  config: AnalysisConfig,
): Promise<CloudOutcome<CloudSyncResult>> {
  const parsed = parseRunFilename(dataset.filename)
  if (parsed.runCode === null) {
    return refuse(
      `ファイル名「${dataset.filename}」から実験の識別子（ラン番号）を読み取れないため、クラウドに保存できません。` +
        'YYMMDD_data.csv（同じ日に複数回行った場合は YYMMDDa_data.csv）の形式で保存し直してください。',
    )
  }
  const runCode = parsed.runCode

  const created = await createRun({ originalFilename: dataset.filename })
  let runId: string
  if (created.ok) {
    runId = created.value.run.id
  } else {
    // The run code is already recorded for this owner. That is not a failure: it
    // is the normal state from the second analysis of a run onwards, and the
    // refusal carries the id of the run to attach this revision to.
    const existingRunId =
      created.kind === 'error' &&
      created.code === 'INVALID_ANALYSIS_CONFIG' &&
      created.details?.reason === 'run_code_already_exists' &&
      typeof created.details.runId === 'string'
        ? created.details.runId
        : null
    if (existingRunId === null) return created
    runId = existingRunId
  }

  const snapshot = await buildSnapshot(dataset, config)

  const revision = await createRevision(runId, {
    sourceSha256: dataset.sourceSha256,
    configHash: snapshot.configHash,
    config,
    engineVersion: ANALYSIS_ENGINE_VERSION,
    appVersion: APP_VERSION,
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    metrics: metricsFor(dataset, config),
  })
  if (!revision.ok) return revision

  /*
   * A revision that already carries its snapshot is finished, and re-uploading is not just
   * redundant — it cannot succeed.
   *
   * A revision is identified by (source bytes, config), so re-opening the same CSV tomorrow
   * resolves to the same revision. The Worker accepts a byte-identical re-upload idempotently, but
   * the browser cannot produce those bytes twice: `analysisTimestamp` records when the analysis
   * ran, and a second analysis genuinely ran at a different time. So the only reachable branch was
   * the refusal — `SNAPSHOT_INVALID / revision_already_has_a_different_snapshot` — and a researcher
   * doing the ordinary thing of opening a file again was shown 失敗 with a retry that could never
   * work, for an analysis that had in fact been stored correctly the first time.
   *
   * The immutability of a revision is what makes skipping correct rather than merely convenient:
   * the stored snapshot and this one describe the same analysis of the same bytes under the same
   * configuration, so there is nothing to update. `hasSnapshot` is checked rather than
   * `created`, because a revision whose first upload failed exists without one and must still be
   * able to receive it.
   */
  if (!revision.value.created && revision.value.revision.hasSnapshot) {
    return {
      ok: true,
      value: {
        runId,
        runCode,
        revisionId: revision.value.revision.id,
        revisionCreated: false,
        snapshotBytes: null,
      },
    }
  }

  const compressed = await gzipCompress(encodeSnapshot(snapshot))
  const upload = await uploadSnapshot(revision.value.revision.id, compressed, {
    declaredBytes: compressed.length,
    // Hashed here and re-hashed by the Worker while it reads the body, then
    // handed to R2 so the store verifies the write as well. The client's number
    // is never trusted; it is what the other two are compared against.
    sha256: await sha256Hex(compressed),
    format: 'json.gz',
  })
  if (!upload.ok) return upload

  return {
    ok: true,
    value: {
      runId,
      runCode,
      revisionId: revision.value.revision.id,
      revisionCreated: revision.value.created,
      snapshotBytes: upload.value.object.byteSize,
    },
  }
}
