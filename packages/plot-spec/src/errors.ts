/**
 * The typed failures a poster spec can be *built* with — as distinct from the failures a poster
 * spec can be *rejected* with once it is already a document.
 *
 * `spec.ts` validates a finished spec and speaks Zod, which is the right language for a schema and
 * the wrong language for a user interface: a `ZodError` says `data.inner.time: array has 431278
 * points, exceeding the 200000-point cap`, when what the researcher needs to be told is "the range
 * you dragged is too wide; narrow it". The builder therefore refuses *before* it produces a
 * document, and refuses with one of the stable codes below, each of which the UI can render as a
 * sentence and act on (offer a narrower range, offer a different sensor, offer nothing at all).
 *
 * This mirrors `@aat/shared`'s `errors.ts` convention deliberately — a fixed set of machine codes
 * that client code branches on, Japanese as the primary locale with English carried alongside, a
 * structured `details` payload, and an internal `cause` that is never part of what gets shown —
 * but it does **not** import it. `codec.ts` records why this package carries no `@aat/shared`
 * dependency, and the Cloudflare Worker, the browser and the Python renderer all consume
 * `@aat/plot-spec` as the neutral contract between them; making the contract package depend on the
 * application's error taxonomy would invert that. Instead each code names the `@aat/shared`
 * `ErrorCode` it should become if it ever has to cross the API boundary — see `apiErrorCode` — so
 * a Worker that builds a spec server-side can translate in one line without this package ever
 * knowing what an HTTP status is.
 */

/**
 * Every way the builder can refuse. Ordered from "the caller passed something structurally wrong"
 * to "what the caller asked for cannot become an honest figure" to "the result failed the schema
 * anyway", which is also roughly the order in which they are checked.
 */
export const POSTER_SPEC_ERROR_CODES = [
  /** A source series is not a pair of equal-length `Float64Array`s, or carries a non-finite value. */
  'POSTER_SOURCE_INVALID',
  /** `series` names a sensor for which no source series was supplied. */
  'POSTER_SERIES_MISSING',
  /** `xMin`/`xMax` are not two finite numbers with `xMin < xMax`. */
  'POSTER_RANGE_INVALID',
  /**
   * The *resolved* `yMin`/`yMax` are not two finite numbers with `yMin < yMax`.
   *
   * Separate from `POSTER_RANGE_INVALID` because either bound may be left to the frozen preset, so
   * the pair that fails can be one the caller supplied and one it did not — "下限 (G) を 2 にした
   * が上限は既定の 1 のまま" is a sentence about the y-axis, and answering it with the x-axis's
   * message would send the researcher to the wrong two fields.
   */
  'POSTER_Y_RANGE_INVALID',
  /** The requested x-range contains no samples at all for a requested sensor. */
  'POSTER_RANGE_EMPTY',
  /** Every requested sensor has samples in range, but every one of those samples is a NaN gap. */
  'POSTER_RANGE_ALL_GAPS',
  /** The requested x-range contains more than `MAX_POINTS` samples for a sensor. */
  'POSTER_RANGE_TOO_MANY_POINTS',
  /** The requested sensors together encode to more than `MAX_PAYLOAD_BYTES`. */
  'POSTER_PAYLOAD_TOO_LARGE',
  /** The assembled document failed `PosterPlotSpecSchema`. Indicates a bug here, not bad data. */
  'POSTER_SPEC_INVALID',
] as const

export type PosterSpecErrorCode = (typeof POSTER_SPEC_ERROR_CODES)[number]

/** Japanese is the primary locale, as in the desktop application and in `@aat/shared`. */
export type PosterSpecLocale = 'ja' | 'en'

/**
 * Structured, JSON-serialisable context for a refusal: which sensor, how many points, what the
 * cap was, what range the data actually covers. This is what lets the UI write a *specific*
 * sentence ("この範囲には 431,278 点あります") instead of a generic one, and what a Worker can log.
 * It never carries the sample data itself, and never carries anything secret.
 */
export type PosterSpecErrorDetails = Record<string, unknown>

/**
 * The `@aat/shared` `ErrorCode` a builder failure becomes when it has to be answered over HTTP.
 *
 * Spelled as string literals rather than imported, for the dependency reason in the module doc.
 * Both names are members of `@aat/shared`'s `ERROR_CODES`; a test in that package guards the list,
 * and `errors.test.ts` here guards that this module only ever names these two.
 */
export type PosterSpecApiErrorCode = 'INVALID_ANALYSIS_CONFIG' | 'EXPORT_TOO_LARGE'

interface PosterSpecErrorSpec {
  message: Record<PosterSpecLocale, string>
  apiErrorCode: PosterSpecApiErrorCode
}

/**
 * The message text for each code, in both locales.
 *
 * Every message is written to be shown to a researcher verbatim, so each one says what happened
 * *and* what to do about it where there is anything to do. "Narrow the range" appears twice
 * because the two size caps are genuinely different limits (per-array point count and aggregate
 * encoded bytes — see `spec.ts`) but have the same remedy; keeping them as separate codes means
 * the UI can still tell them apart in a diagnostic even though it offers the same advice.
 */
const POSTER_SPEC_ERROR_SPECS: Record<PosterSpecErrorCode, PosterSpecErrorSpec> = {
  POSTER_SOURCE_INVALID: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: 'ポスターの元データが不正です。',
      en: 'The poster source series is invalid.',
    },
  },
  POSTER_SERIES_MISSING: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: '選択したセンサーのデータがありません。',
      en: 'No source series was supplied for the selected sensor.',
    },
  },
  POSTER_RANGE_INVALID: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: '表示範囲の指定が正しくありません。開始時刻は終了時刻より小さい有限の値にしてください。',
      en: 'The requested range is invalid: xMin and xMax must be finite with xMin < xMax.',
    },
  },
  POSTER_Y_RANGE_INVALID: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: 'Y軸の範囲の指定が正しくありません。下限は上限より小さい有限の値にしてください。',
      en: 'The requested y-range is invalid: yMin and yMax must be finite with yMin < yMax.',
    },
  },
  POSTER_RANGE_EMPTY: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: '選択した範囲にデータがありません。範囲を変更してください。',
      en: 'The selected range contains no samples. Choose a different range.',
    },
  },
  POSTER_RANGE_ALL_GAPS: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: '選択した範囲は欠測のみです。範囲を変更してください。',
      en: 'The selected range contains only gaps (no measured values). Choose a different range.',
    },
  },
  POSTER_RANGE_TOO_MANY_POINTS: {
    apiErrorCode: 'EXPORT_TOO_LARGE',
    message: {
      ja: '選択した範囲のデータ点数が上限を超えています。範囲を狭めてください。',
      en: 'The selected range has more samples than a poster may carry. Narrow the range.',
    },
  },
  POSTER_PAYLOAD_TOO_LARGE: {
    apiErrorCode: 'EXPORT_TOO_LARGE',
    message: {
      ja: '選択した範囲のデータ量が上限を超えています。範囲を狭めてください。',
      en: 'The selected range exceeds the maximum poster payload size. Narrow the range.',
    },
  },
  POSTER_SPEC_INVALID: {
    apiErrorCode: 'INVALID_ANALYSIS_CONFIG',
    message: {
      ja: 'ポスターの指定が正しくありません。',
      en: 'The assembled poster specification is invalid.',
    },
  },
}

export interface PosterSpecErrorOptions {
  /** Locale for `.message`. Both locales are always available on `.messages`. */
  locale?: PosterSpecLocale
  details?: PosterSpecErrorDetails
  /** Internal only. Never read by `.messages` or `.details`, so it cannot leak into a UI or a body. */
  cause?: unknown
}

/**
 * A refusal from the spec builder.
 *
 * Carries the stable `code` first and the prose second, because the code is what callers should
 * branch on: `POSTER_RANGE_TOO_MANY_POINTS` means "offer a narrower selection",
 * `POSTER_SERIES_MISSING` means "offer a different sensor", and the wording of either may change
 * without breaking that logic. The underlying `ZodError` (for `POSTER_SPEC_INVALID`) or `TypeError`
 * is attached as `cause` for the console and never surfaces through `messages` or `details`.
 */
export class PosterSpecError extends Error {
  readonly code: PosterSpecErrorCode
  /** Both locales, so a UI can switch language without rebuilding the spec. */
  readonly messages: Readonly<Record<PosterSpecLocale, string>>
  readonly apiErrorCode: PosterSpecApiErrorCode
  readonly details?: PosterSpecErrorDetails

  constructor(code: PosterSpecErrorCode, options: PosterSpecErrorOptions = {}) {
    const spec = POSTER_SPEC_ERROR_SPECS[code]
    const locale = options.locale ?? 'ja'
    super(spec.message[locale], options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'PosterSpecError'
    this.code = code
    this.messages = { ...spec.message }
    this.apiErrorCode = spec.apiErrorCode
    if (options.details !== undefined) this.details = options.details
  }

  /** The message in a specific locale, for a UI whose language is decided after the throw. */
  messageFor(locale: PosterSpecLocale): string {
    return this.messages[locale]
  }
}

/**
 * Narrow an unknown caught value to a {@link PosterSpecError}.
 *
 * Checks the `code` field rather than using `instanceof`, which is unreliable across realms — the
 * analysis Web Worker and the main thread do not share a class identity, and a spec built inside
 * the worker and rejected there arrives on the other side as a structured clone.
 */
export function isPosterSpecError(value: unknown): value is PosterSpecError {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && (POSTER_SPEC_ERROR_CODES as readonly string[]).includes(code)
}
