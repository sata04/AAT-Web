/**
 * @aat/plot-spec — the declarative poster plot specification.
 *
 * This is the ONLY thing the browser is allowed to send to the poster renderer (a Cloudflare
 * Container running Python + Matplotlib Agg). See `spec.ts` for the full contract.
 */

export type {
  AutoPosterPlotSpecBuildRequest,
  PosterPlotSpecBuildRequest,
  PosterSpecSource,
} from './builder.ts'
export { autoPosterRange, buildAutoPosterPlotSpec, buildPosterPlotSpec } from './builder.ts'
export {
  base64ToBytes,
  bytesToBase64,
  canonicalStringify,
  decodeFloat64Array,
  encodeFloat64Array,
  sha256Hex,
} from './codec.ts'
export type {
  PosterSpecApiErrorCode,
  PosterSpecErrorCode,
  PosterSpecErrorDetails,
  PosterSpecErrorOptions,
  PosterSpecLocale,
} from './errors.ts'
export { isPosterSpecError, POSTER_SPEC_ERROR_CODES, PosterSpecError } from './errors.ts'
export type {
  PosterDpiOption,
  PosterFigureSizeId,
  PosterFigureSizeOption,
  PosterFormDefaults,
  PosterSeriesOption,
} from './poster-form.ts'
export {
  DEFAULT_POSTER_FIGURE_SIZE_ID,
  findPosterFigureSize,
  POSTER_SERIES_OPTIONS,
  posterDisplayName,
  posterDpiOptions,
  posterFigureSizeOptions,
  posterFormDefaults,
  posterTitleLine,
} from './poster-form.ts'
export type { PosterFigureRecord, PosterFigureStatus } from './poster-record.ts'
export {
  PosterFigureRecordSchema,
  PosterFigureStatusSchema,
  parsePosterFigureRecord,
  safeParsePosterFigureRecord,
} from './poster-record.ts'
export type {
  PosterDefaultsSpec,
  PosterLabelsSpec,
  PosterLineStyle,
  PosterPreset,
  PosterPresetVersion,
  PosterWatermarkSpec,
} from './presets.ts'
export {
  AAT_POSTER_V1_PRESET,
  DEFAULT_POSTER_PRESET_VERSION,
  getPosterPreset,
  isPosterPresetVersion,
  POSTER_PRESET_VERSIONS,
  POSTER_PRESETS,
  posterPresetContentHash,
} from './presets.ts'
export type { FullResolutionSeries } from './source.ts'
export { asFullResolutionSeries, isFullResolutionSeries } from './source.ts'
export type {
  EncodedFloat64Series,
  PosterKind,
  PosterPlotSpec,
  PosterSeriesData,
  SeriesSelection,
} from './spec.ts'
export {
  DPI_MAX,
  DPI_MIN,
  FIGURE_DIMENSION_MAX_INCHES,
  FIGURE_DIMENSION_MIN_INCHES,
  MAX_PAYLOAD_BYTES,
  MAX_POINTS,
  PosterKindSchema,
  PosterPlotSpecSchema,
  PosterPresetVersionSchema,
  parsePosterPlotSpec,
  SeriesSelectionSchema,
  safeParsePosterPlotSpec,
  specHash,
  TITLE_MAX_LENGTH,
} from './spec.ts'
export { decodeSeries, encodeSeries, isWellFormedEncodedSeries } from './wire.ts'
