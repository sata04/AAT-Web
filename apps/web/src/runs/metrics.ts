/**
 * Decoding the headline metrics a revision carries.
 *
 * `GET /api/v1/revisions/:revisionId` re-parses stored JSON text and hands it back without
 * re-validating it, which is why `RevisionDetail['metrics']` is typed with `unknown` scalars. That
 * honesty is the point: the values are the tagged form `@aat/shared` uses for the four numbers JSON
 * cannot spell — `"NaN"`, `"Infinity"`, `"-Infinity"` and `"-0"` — and a structural type claiming
 * `number` would be a lie that only shows up as a `null` in a results table.
 *
 * So this module narrows before it decodes. `asEncodedScalar` admits a number or one of exactly
 * four strings and answers `null` for everything else; `decodeScalar` then turns the tag back into
 * the value. The `-0` tag is not decoration: `JSON.stringify(-0) === "0"`, so without it a window
 * statistic that is exactly negative zero would come back positive, which is a different number.
 */

import type { GQualityRow, WindowStatistics } from '@aat/analysis-core'
import { decodeScalar, type EncodedScalar } from '@aat/shared'
import type { RevisionDetail } from '../cloud/gateway.ts'

const SCALAR_TAGS: ReadonlySet<string> = new Set(['NaN', 'Infinity', '-Infinity', '-0'])

/** Narrow an untrusted value to the wire form of a scalar, or `null` for "not available". */
export function asEncodedScalar(value: unknown): EncodedScalar | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && SCALAR_TAGS.has(value)) return value as EncodedScalar
  return null
}

/** Narrow then decode, in the one step every caller here wants. */
function scalar(value: unknown): number | null {
  return decodeScalar(asEncodedScalar(value))
}

function windowStatistics(raw: unknown): WindowStatistics {
  if (typeof raw !== 'object' || raw === null) return { mean: null, startTime: null, std: null }
  const record = raw as Record<string, unknown>
  return {
    mean: scalar(record.mean),
    startTime: scalar(record.startTime),
    std: scalar(record.std),
  }
}

export interface RunMetrics {
  /** The analysis window width the min-SD search used, in seconds. */
  windowSize: number | null
  inner: WindowStatistics
  drag: WindowStatistics
  innerSampleCount: number
  dragSampleCount: number
  warningCount: number
  /** Empty when the sweep was skipped, which is a normal outcome rather than a missing value. */
  gQuality: readonly GQualityRow[]
}

/**
 * Decode a revision's metrics row.
 *
 * `gQuality` is stored as a JSON blob and comes back as `unknown`; a row that is not an object, or
 * whose `windowSize` is not a number, is dropped rather than admitted with a null window — a
 * G-quality row is keyed by its window size, so a row without one is not a row.
 */
export function decodeRunMetrics(raw: RevisionDetail['metrics']): RunMetrics | null {
  if (raw === null) return null

  const gQuality: GQualityRow[] = []
  if (Array.isArray(raw.gQuality)) {
    for (const entry of raw.gQuality) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.windowSize !== 'number') continue
      gQuality.push({
        windowSize: record.windowSize,
        innerStartTime: scalar(record.innerStartTime),
        innerMean: scalar(record.innerMean),
        innerStd: scalar(record.innerStd),
        dragStartTime: scalar(record.dragStartTime),
        dragMean: scalar(record.dragMean),
        dragStd: scalar(record.dragStd),
      })
    }
  }

  return {
    windowSize: scalar(raw.windowSize),
    inner: windowStatistics(raw.inner),
    drag: windowStatistics(raw.drag),
    innerSampleCount: raw.innerSampleCount,
    dragSampleCount: raw.dragSampleCount,
    warningCount: raw.warningCount,
    gQuality,
  }
}

export interface GQualitySummary {
  /** How many window widths the sweep covered. */
  windowCount: number
  smallestWindow: number | null
  largestWindow: number | null
  /** The lowest standard deviation the sweep found, per sensor, and the window it was found at. */
  bestInner: { std: number; windowSize: number } | null
  bestDrag: { std: number; windowSize: number } | null
}

/**
 * Summarise a G-quality sweep for a gallery card.
 *
 * "Best" is the *minimum* standard deviation across window widths, which is the number the sweep
 * exists to find: G-quality asks how steady the microgravity is, and a smaller standard deviation
 * is a steadier run. Only finite values are considered — a window that produced NaN produced no
 * answer, and letting NaN through a `<` comparison would silently make it never win rather than
 * making it obviously absent.
 */
export function summariseGQuality(rows: readonly GQualityRow[]): GQualitySummary | null {
  if (rows.length === 0) return null

  let smallestWindow = Number.POSITIVE_INFINITY
  let largestWindow = Number.NEGATIVE_INFINITY
  let bestInner: GQualitySummary['bestInner'] = null
  let bestDrag: GQualitySummary['bestDrag'] = null

  for (const row of rows) {
    if (Number.isFinite(row.windowSize)) {
      if (row.windowSize < smallestWindow) smallestWindow = row.windowSize
      if (row.windowSize > largestWindow) largestWindow = row.windowSize
    }
    if (row.innerStd !== null && Number.isFinite(row.innerStd)) {
      if (bestInner === null || row.innerStd < bestInner.std) {
        bestInner = { std: row.innerStd, windowSize: row.windowSize }
      }
    }
    if (row.dragStd !== null && Number.isFinite(row.dragStd)) {
      if (bestDrag === null || row.dragStd < bestDrag.std) {
        bestDrag = { std: row.dragStd, windowSize: row.windowSize }
      }
    }
  }

  return {
    windowCount: rows.length,
    smallestWindow: Number.isFinite(smallestWindow) ? smallestWindow : null,
    largestWindow: Number.isFinite(largestWindow) ? largestWindow : null,
    bestInner,
    bestDrag,
  }
}
