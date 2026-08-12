/**
 * @aat/plot-spec — the declarative poster plot specification.
 *
 * This is the ONLY thing the browser is allowed to send to the poster renderer (a Cloudflare
 * Container running Python + Matplotlib Agg). See `spec.ts` for the full contract.
 */

export {
  DPI_MAX,
  DPI_MIN,
  FIGURE_DIMENSION_MAX_INCHES,
  FIGURE_DIMENSION_MIN_INCHES,
  MAX_PAYLOAD_BYTES,
  MAX_POINTS,
  parsePosterPlotSpec,
  PosterKindSchema,
  PosterPlotSpecSchema,
  PosterPresetVersionSchema,
  safeParsePosterPlotSpec,
  SeriesSelectionSchema,
  specHash,
  TITLE_MAX_LENGTH,
} from './spec.ts'
export type { EncodedFloat64Series, PosterKind, PosterPlotSpec, PosterSeriesData, SeriesSelection } from './spec.ts'

export {
  AAT_POSTER_V1_PRESET,
  getPosterPreset,
  POSTER_PRESET_VERSIONS,
  POSTER_PRESETS,
  posterPresetContentHash,
} from './presets.ts'
export type {
  PosterDefaultsSpec,
  PosterLabelsSpec,
  PosterLineStyle,
  PosterPreset,
  PosterPresetVersion,
  PosterWatermarkSpec,
} from './presets.ts'

export {
  parsePosterFigureRecord,
  PosterFigureRecordSchema,
  PosterFigureStatusSchema,
  safeParsePosterFigureRecord,
} from './poster-record.ts'
export type { PosterFigureRecord, PosterFigureStatus } from './poster-record.ts'

export { base64ToBytes, bytesToBase64, canonicalStringify, decodeFloat64Array, encodeFloat64Array, sha256Hex } from './codec.ts'

export { decodeSeries, encodeSeries, isWellFormedEncodedSeries } from './wire.ts'
