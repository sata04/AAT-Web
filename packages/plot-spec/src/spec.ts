/**
 * The poster plot spec: the ONLY thing the browser is allowed to send to the poster renderer (a
 * Cloudflare Container running Python + Matplotlib Agg, kept pixel-compatible with the desktop
 * app's exported PNGs). It is a strictly validated, declarative description of one figure — never
 * code, a file path, a filename, an rcParams blob, or shell arguments. Anything the renderer needs
 * to draw a poster must be expressible as a field here; if it isn't, it does not get to the
 * renderer at all.
 *
 * `series` selects which sensor traces the figure shows ('inner' | 'drag' | 'both'), and `data`
 * must carry exactly the arrays that selection implies — no more, no less. See `wire.ts` for how
 * the numeric arrays themselves are encoded.
 */

import { z } from 'zod'
import { canonicalStringify, sha256Hex } from './codec.ts'
import { POSTER_PRESET_VERSIONS, type PosterPresetVersion } from './presets.ts'
import { decodeSeries, type EncodedFloat64Series, isWellFormedEncodedSeries } from './wire.ts'

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

/**
 * Maximum samples accepted per array (time or values) of a single series.
 *
 * A poster's x-range is a bounded drop-tower window (the desktop default is 1.45s; even the
 * "show all data" view rarely exceeds a couple of minutes), and the desktop app samples at up to
 * a few kHz — so a real analysis run's full-resolution series tops out in the low hundreds of
 * thousands of points. 200,000 comfortably covers that (including a generously long "show all"
 * window at 1kHz) while still bounding one series' decoded size to 200,000 * 8 bytes = 1.6MB, so
 * the renderer's per-request memory and Matplotlib's per-line vertex count both stay predictable
 * regardless of what a client sends.
 */
export const MAX_POINTS = 200_000

/**
 * Maximum total base64-encoded size (in bytes; base64 is ASCII, so this equals character count)
 * across every array present in `data` (`time` and `values`, for every requested series). This
 * bounds the actual over-the-wire JSON payload size, which is what an API layer needs to reject
 * before it even finishes buffering the request body — not the larger decoded size, which is
 * checked separately (implicitly, via `MAX_POINTS`) once a request has already been accepted.
 *
 * This is a genuinely independent limit from `MAX_POINTS`, not a restatement of it: the worst
 * case `MAX_POINTS` alone allows — `series: 'both'`, all four arrays (time + values, inner +
 * drag) at exactly 200,000 points — encodes to
 * `4 * ceil(200,000 * 8 / 3) * 4 = 8,533,344 bytes` (~8.14MB), which is already just over this
 * 8MB (8 * 1024 * 1024 = 8,388,608 bytes) cap. So `MAX_POINTS` catches any single array that is
 * simply too long, while `MAX_PAYLOAD_BYTES` catches an otherwise-compliant request that is too
 * big in aggregate (both sensors each sized near the per-array cap at once) — a client can have
 * one array at the point cap, or two sensors each a bit under it, but not both sensors maxed out
 * simultaneously.
 */
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024

/** Inches. Matches Matplotlib `figsize` sanity bounds: too small to read, too large to be a "poster". */
export const FIGURE_DIMENSION_MIN_INCHES = 2
export const FIGURE_DIMENSION_MAX_INCHES = 20

/** Matplotlib's own practical range: below 72 text becomes illegible even at poster size; above 600 is print-shop territory no browser workflow needs. */
export const DPI_MIN = 72
export const DPI_MAX = 600

export const TITLE_MAX_LENGTH = 120

// ---------------------------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------------------------

/** Same run-code shape as `@aat/shared`'s `parseRunFilename` produces: `YYMMDD` plus an optional single lowercase suffix letter. */
const RUN_CODE_PATTERN = /^\d{6}[a-z]?$/

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point; this pattern rejects them from titles.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export const PosterKindSchema = z.enum(['auto', 'custom'])
export type PosterKind = z.infer<typeof PosterKindSchema>

export const SeriesSelectionSchema = z.enum(['inner', 'drag', 'both'])
export type SeriesSelection = z.infer<typeof SeriesSelectionSchema>

export const PosterPresetVersionSchema = z.enum(POSTER_PRESET_VERSIONS)

const EncodedFloat64SeriesSchema = z
  .object({
    data: z.string(),
    length: z.number().int().nonnegative(),
  })
  .strict()

const SeriesDataSchema = z
  .object({
    time: EncodedFloat64SeriesSchema,
    values: EncodedFloat64SeriesSchema,
  })
  .strict()

export type PosterSeriesData = z.infer<typeof SeriesDataSchema>

const PosterPlotDataSchema = z
  .object({
    inner: SeriesDataSchema.optional(),
    drag: SeriesDataSchema.optional(),
  })
  .strict()

// ---------------------------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------------------------

const PosterPlotSpecShape = z
  .object({
    /** Identifies the analysis (CSV + config) this poster is drawn from; opaque to this package. */
    analysisRevisionId: z.string().min(1).max(200),
    runCode: z
      .string()
      .regex(
        RUN_CODE_PATTERN,
        'runCode must be six digits optionally followed by one lowercase suffix letter (e.g. "260811" or "260811a")',
      ),
    posterKind: PosterKindSchema,
    posterPresetVersion: PosterPresetVersionSchema,
    xMin: z.number().finite(),
    xMax: z.number().finite(),
    yMin: z.number().finite().optional(),
    yMax: z.number().finite().optional(),
    series: SeriesSelectionSchema,
    title: z
      .string()
      .max(TITLE_MAX_LENGTH, `title must be at most ${TITLE_MAX_LENGTH} characters`)
      .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
        message: 'title must not contain control characters or newlines',
      }),
    showLegend: z.boolean(),
    figureWidth: z.number().finite().min(FIGURE_DIMENSION_MIN_INCHES).max(FIGURE_DIMENSION_MAX_INCHES),
    figureHeight: z.number().finite().min(FIGURE_DIMENSION_MIN_INCHES).max(FIGURE_DIMENSION_MAX_INCHES),
    dpi: z.number().int().min(DPI_MIN).max(DPI_MAX),
    data: PosterPlotDataSchema,
  })
  .strict()

type SeriesKey = 'inner' | 'drag'

/**
 * Validate one `data.<key>` entry's structure and content, returning the total decoded byte count
 * it contributes (0 if `entry` is absent) so the caller can enforce {@link MAX_PAYLOAD_BYTES}
 * across every series at once.
 */
function validateSeriesEntry(
  key: SeriesKey,
  entry: PosterSeriesData | undefined,
  ctx: z.RefinementCtx,
): number {
  if (!entry) return 0
  const { time, values } = entry

  const timeWellFormed = isWellFormedEncodedSeries(time)
  const valuesWellFormed = isWellFormedEncodedSeries(values)

  if (!timeWellFormed) {
    ctx.addIssue({
      code: 'custom',
      message: `data.${key}.time is not a well-formed encoded series (base64 length must equal length * 8 bytes, padded)`,
      path: ['data', key, 'time'],
    })
  }
  if (!valuesWellFormed) {
    ctx.addIssue({
      code: 'custom',
      message: `data.${key}.values is not a well-formed encoded series (base64 length must equal length * 8 bytes, padded)`,
      path: ['data', key, 'values'],
    })
  }

  if (time.length !== values.length) {
    ctx.addIssue({
      code: 'custom',
      message: `data.${key}.time and data.${key}.values must have equal length (got ${time.length} and ${values.length})`,
      path: ['data', key],
    })
  }

  if (time.length > MAX_POINTS) {
    ctx.addIssue({
      code: 'custom',
      message: `data.${key}.time has ${time.length} points, exceeding the ${MAX_POINTS}-point cap`,
      path: ['data', key, 'time'],
    })
  }
  if (values.length > MAX_POINTS) {
    ctx.addIssue({
      code: 'custom',
      message: `data.${key}.values has ${values.length} points, exceeding the ${MAX_POINTS}-point cap`,
      path: ['data', key, 'values'],
    })
  }

  // Wire-size accounting for MAX_PAYLOAD_BYTES uses the encoded (base64) length, i.e. what
  // actually crosses the wire as JSON string content — see MAX_PAYLOAD_BYTES's doc comment for
  // why this, not the larger decoded size, is the independent cap.
  let wireBytes = 0

  // Only decode arrays that are at least structurally sound; a malformed body already failed above.
  if (timeWellFormed) {
    wireBytes += time.data.length
    let decodedTime: Float64Array
    try {
      decodedTime = decodeSeries(time)
    } catch {
      decodedTime = new Float64Array(0)
    }
    for (let index = 0; index < decodedTime.length; index++) {
      if (!Number.isFinite(decodedTime[index])) {
        ctx.addIssue({
          code: 'custom',
          message: `data.${key}.time[${index}] must be finite; NaN and Infinity are not allowed in time`,
          path: ['data', key, 'time'],
        })
        break // one report is enough to reject the request; scanning further just spams issues
      }
    }
  }

  if (valuesWellFormed) {
    wireBytes += values.data.length
    let decodedValues: Float64Array
    try {
      decodedValues = decodeSeries(values)
    } catch {
      decodedValues = new Float64Array(0)
    }
    for (let index = 0; index < decodedValues.length; index++) {
      const sample = decodedValues[index] as number
      // NaN is the documented "gap" marker (see wire.ts) and is allowed; +/-Infinity never is.
      if (!Number.isFinite(sample) && !Number.isNaN(sample)) {
        ctx.addIssue({
          code: 'custom',
          message: `data.${key}.values[${index}] must be finite or NaN (a gap); +/-Infinity is not allowed`,
          path: ['data', key, 'values'],
        })
        break
      }
    }
  }

  return wireBytes
}

export const PosterPlotSpecSchema = PosterPlotSpecShape.superRefine((value, ctx) => {
  if (value.xMin >= value.xMax) {
    ctx.addIssue({ code: 'custom', message: 'xMin must be less than xMax', path: ['xMin'] })
  }
  if (value.yMin !== undefined && value.yMax !== undefined && value.yMin >= value.yMax) {
    ctx.addIssue({ code: 'custom', message: 'yMin must be less than yMax', path: ['yMin'] })
  }

  const requiresInner = value.series === 'inner' || value.series === 'both'
  const requiresDrag = value.series === 'drag' || value.series === 'both'

  if (requiresInner && !value.data.inner) {
    ctx.addIssue({
      code: 'custom',
      message: `series "${value.series}" requires data.inner`,
      path: ['data', 'inner'],
    })
  }
  if (!requiresInner && value.data.inner) {
    ctx.addIssue({
      code: 'custom',
      message: `series "${value.series}" must not include data.inner`,
      path: ['data', 'inner'],
    })
  }
  if (requiresDrag && !value.data.drag) {
    ctx.addIssue({
      code: 'custom',
      message: `series "${value.series}" requires data.drag`,
      path: ['data', 'drag'],
    })
  }
  if (!requiresDrag && value.data.drag) {
    ctx.addIssue({
      code: 'custom',
      message: `series "${value.series}" must not include data.drag`,
      path: ['data', 'drag'],
    })
  }

  const innerWireBytes = validateSeriesEntry('inner', value.data.inner, ctx)
  const dragWireBytes = validateSeriesEntry('drag', value.data.drag, ctx)

  const totalWireBytes = innerWireBytes + dragWireBytes
  if (totalWireBytes > MAX_PAYLOAD_BYTES) {
    ctx.addIssue({
      code: 'custom',
      message: `encoded series payload is ${totalWireBytes} bytes, exceeding the ${MAX_PAYLOAD_BYTES}-byte cap`,
      path: ['data'],
    })
  }
})

export type PosterPlotSpec = z.infer<typeof PosterPlotSpecSchema>

/** Parse and validate an unknown value as a {@link PosterPlotSpec}. */
export function parsePosterPlotSpec(input: unknown): PosterPlotSpec {
  return PosterPlotSpecSchema.parse(input)
}

/** Like {@link parsePosterPlotSpec}, but returns a Zod result instead of throwing. */
export function safeParsePosterPlotSpec(input: unknown) {
  return PosterPlotSpecSchema.safeParse(input)
}

/**
 * Stable SHA-256 (lowercase hex) of a validated spec, over a canonical JSON serialisation (object
 * keys sorted recursively — see `codec.ts`). Two specs that are deep-equal always hash the same
 * regardless of how their object literals were built; any field that differs (including the
 * encoded data arrays) changes the hash. Used for idempotency (submitting the same spec twice
 * should not render twice) and provenance (a stored poster's `specHash` records exactly what was
 * asked for).
 */
export async function specHash(spec: PosterPlotSpec): Promise<string> {
  return sha256Hex(canonicalStringify(spec as unknown as Record<string, unknown>))
}

export type { EncodedFloat64Series, PosterPresetVersion }
