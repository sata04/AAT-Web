/**
 * The cloud analysis snapshot: everything needed to replay a run's graph, recompute
 * user-selected-range statistics, regenerate its Excel export and build a custom poster, without
 * needing the original source CSV ever again. This is the canonical analytical record for a run
 * once it has been analysed — it MUST NOT be downsampled or thinned; storage cost is a solved
 * problem (gzip via `gzip.ts`, or simply cheap object storage), silently-lossy history is not.
 *
 * ## NaN / Infinity encoding
 *
 * Plain JSON has no representation for NaN or +/-Infinity, both of which are legitimate values in
 * this domain (a missing sample, a saturated sensor, a window with no valid data). Two encodings
 * are used, chosen per shape:
 *
 *  - **Full-resolution numeric series** are encoded as base64 of a little-endian `Float64Array`
 *    (see `binary.ts`). This is exact for every IEEE-754 bit pattern — NaN, +Infinity,
 *    -Infinity, -0, and any payload a signalling/quiet NaN might carry all round-trip bit for
 *    bit — and is far more compact than a JSON number array with string-tagged exceptions
 *    scattered through it.
 *  - **Scalars** (a single mean/std/start-time value in `statistics` or a `gQuality` row) use the
 *    tagged-string form `"NaN"` / `"Infinity"` / `"-Infinity"` / `"-0"` in place of the number.
 *    JSON's own `-0 -> 0` collapse (`JSON.stringify(-0) === "0"`) makes `"-0"` a deliberate fourth
 *    tag here, not an oversight: without it a window statistic that is exactly negative zero
 *    would silently become positive zero across a save/load round trip.
 *
 * `encodeSnapshot` / `decodeSnapshot` are the only supported way to turn a snapshot into bytes and
 * back; `decodeSnapshot` always re-validates against {@link AnalysisSnapshotSchema}, so a
 * corrupted or hand-edited snapshot fails loudly (`SNAPSHOT_INVALID`, see `errors.ts`) instead of
 * silently propagating bad data into a graph or export.
 */

import { z } from 'zod'
import { decodeFloat64Array, encodeFloat64Array } from './binary.ts'
import { AnalysisConfigSchema } from './config.ts'
import { sha256Hex } from './hash.ts'

export const SNAPSHOT_FORMAT_VERSION = 1

const EncodedScalarSchema = z.union([
  z.number(),
  z.literal('NaN'),
  z.literal('Infinity'),
  z.literal('-Infinity'),
  z.literal('-0'),
])

/** A single statistics scalar as it appears on the wire: a finite number, or one of the four tags. */
export type EncodedScalar = z.infer<typeof EncodedScalarSchema>

/** Encode a scalar (or `null`, meaning "not available") for JSON storage. See module docs. */
export function encodeScalar(value: number | null): EncodedScalar | null {
  if (value === null) return null
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return 'Infinity'
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return value
}

/** Inverse of {@link encodeScalar}. */
export function decodeScalar(value: EncodedScalar | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (value === 'NaN') return Number.NaN
  if (value === 'Infinity') return Number.POSITIVE_INFINITY
  if (value === '-Infinity') return Number.NEGATIVE_INFINITY
  if (value === '-0') return -0
  return value
}

const EncodedScalarOrNullSchema = EncodedScalarSchema.nullable()

const EncodedSeriesSchema = z.object({
  /** Base64 of the little-endian Float64Array bytes. */
  data: z.string(),
  /** Element count, redundant with `data`'s length but checked on decode to catch truncation. */
  length: z.number().int().nonnegative(),
})

/** A full-resolution numeric series as it appears on the wire. */
export type EncodedSeries = z.infer<typeof EncodedSeriesSchema>

export function encodeSeries(values: Float64Array): EncodedSeries {
  return { data: encodeFloat64Array(values), length: values.length }
}

export function decodeSeries(series: EncodedSeries): Float64Array {
  const values = decodeFloat64Array(series.data)
  if (values.length !== series.length) {
    throw new Error(
      `Snapshot series length mismatch: header declares ${series.length} elements, decoded ${values.length}`,
    )
  }
  return values
}

const WindowStatisticsSchema = z.object({
  mean: EncodedScalarOrNullSchema,
  startTime: EncodedScalarOrNullSchema,
  std: EncodedScalarOrNullSchema,
})

/** Per-sensor minimum-standard-deviation window statistics, as computed by `calculateStatistics`. */
const SensorStatisticsSchema = z.object({
  inner: WindowStatisticsSchema,
  drag: WindowStatisticsSchema,
})

/** One row of the multi-window G-quality sweep (one window size, both sensors). */
const GQualityRowSchema = z.object({
  windowSize: z.number(),
  innerStartTime: EncodedScalarOrNullSchema,
  innerMean: EncodedScalarOrNullSchema,
  innerStd: EncodedScalarOrNullSchema,
  dragStartTime: EncodedScalarOrNullSchema,
  dragMean: EncodedScalarOrNullSchema,
  dragStd: EncodedScalarOrNullSchema,
})

/** Where each sensor's sync point landed, and how many threshold-crossing candidates existed. */
const SyncMetadataSchema = z.object({
  innerIndex: z.number().int().nullable(),
  dragIndex: z.number().int().nullable(),
  /** Sample index used when the primary sync strategy found no crossing, else `null`. */
  innerFallback: z.number().int().nullable(),
  dragFallback: z.number().int().nullable(),
  innerCandidateCount: z.number().int().nonnegative(),
  dragCandidateCount: z.number().int().nonnegative(),
})

/** The index range each sensor's filtered (post-sync, pre-end-of-microgravity) series covers. */
const FilterMetadataSchema = z.object({
  endIndex: z.number().int().nullable(),
  innerLength: z.number().int().nonnegative(),
  dragLength: z.number().int().nonnegative(),
  innerStartIndex: z.number().int().nullable(),
  innerEndIndex: z.number().int().nullable(),
  dragStartIndex: z.number().int().nullable(),
  dragEndIndex: z.number().int().nullable(),
})

const DetectedColumnsSchema = z.object({
  time: z.array(z.string()),
  acceleration: z.array(z.string()),
})

/**
 * Every full-resolution series needed to redraw the graph, recompute range statistics over any
 * user-selected span, and rebuild the Excel export's "Data" and "Acceleration Data" sheets.
 * Present (possibly zero-length) even for a sensor the run didn't use, so downstream code never
 * has to branch on a field being absent — only on it being empty.
 */
const SeriesSchema = z.object({
  innerAdjustedTime: EncodedSeriesSchema,
  dragAdjustedTime: EncodedSeriesSchema,
  innerGravity: EncodedSeriesSchema,
  dragGravity: EncodedSeriesSchema,
  /** Raw acceleration (m/s^2), sync-adjusted, before gravity-unit conversion. */
  innerAcceleration: EncodedSeriesSchema,
  dragAcceleration: EncodedSeriesSchema,
  filteredTime: EncodedSeriesSchema,
  filteredAdjustedTime: EncodedSeriesSchema,
  filteredInnerGravity: EncodedSeriesSchema,
  filteredDragGravity: EncodedSeriesSchema,
})

/** Where this snapshot came from. Extra fields are preserved (`.passthrough()`) for forward compatibility. */
const ProvenanceSchema = z
  .object({
    source: z.enum(['csv_upload', 'desktop_import', 'manual']),
    uploadedByUserId: z.string().optional(),
    uploadedAt: z.string().optional(),
    /** `app_version` from a migrated desktop config.json, if this snapshot originated there. */
    originalDesktopAppVersion: z.string().optional(),
  })
  .passthrough()

export const AnalysisSnapshotSchema = z.object({
  snapshotFormatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  /** Version of the TypeScript analysis engine (`@aat/analysis-core`) that produced this snapshot. */
  analysisEngineVersion: z.string(),
  /** Version of the web application that produced this snapshot. */
  appVersion: z.string(),
  /** SHA-256 of the original source CSV bytes, for provenance and de-duplication. */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  originalFilename: z.string(),
  config: AnalysisConfigSchema,
  /** `configHash(config)` at analysis time — a cheap way to notice a config/snapshot mismatch. */
  configHash: z.string().regex(/^[0-9a-f]{64}$/),
  detectedColumns: DetectedColumnsSchema,
  sync: SyncMetadataSchema,
  filter: FilterMetadataSchema,
  /** User-facing warnings produced during analysis (e.g. a sensor's sync point used a fallback). */
  warnings: z.array(z.string()),
  series: SeriesSchema,
  statistics: SensorStatisticsSchema,
  gQuality: z.array(GQualityRowSchema),
  provenance: ProvenanceSchema,
  /** ISO 8601 timestamp of when the analysis was computed. */
  analysisTimestamp: z.string(),
})

export type AnalysisSnapshot = z.infer<typeof AnalysisSnapshotSchema>

/**
 * Validate and serialise a snapshot to bytes (UTF-8 JSON). Throws a Zod error if `snapshot`
 * doesn't conform — callers at the API boundary should catch this and respond `SNAPSHOT_INVALID`.
 */
export function encodeSnapshot(snapshot: AnalysisSnapshot): Uint8Array {
  const validated = AnalysisSnapshotSchema.parse(snapshot)
  return new TextEncoder().encode(JSON.stringify(validated))
}

/**
 * Parse and validate bytes produced by {@link encodeSnapshot} (optionally after decompressing
 * them with `gzipDecompress` from `gzip.ts` first). Throws if the bytes are not valid UTF-8 JSON,
 * or the parsed document does not conform to {@link AnalysisSnapshotSchema}.
 */
export function decodeSnapshot(bytes: Uint8Array): AnalysisSnapshot {
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const parsed: unknown = JSON.parse(json)
  return AnalysisSnapshotSchema.parse(parsed)
}

/** SHA-256 (hex) over the exact encoded bytes, e.g. for an integrity check alongside stored blobs. */
export function snapshotIntegritySha256(encoded: Uint8Array): Promise<string> {
  return sha256Hex(encoded)
}
