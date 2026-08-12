/**
 * Experiment run identification from source CSV filenames.
 *
 * The drop-tower workflow names files `YYMMDD_data.csv`, with an optional single lowercase
 * suffix letter (`a`, `b`, `c`, ...) when more than one run happens on the same calendar day —
 * `260811a_data.csv` and `260811b_data.csv` are two distinct runs, not two copies of one run.
 * The suffix is therefore part of the run's identity: `runCode` is the date plus the suffix
 * (e.g. "260811a"), not just the date.
 */

const RUN_FILENAME_PATTERN = /^(?<date>\d{6})(?<suffix>[a-z]?)_data\.csv$/

export interface ParsedRunFilename {
  matched: boolean
  /** Date digits plus suffix, e.g. "260812" or "260811a". `null` when `matched` is false. */
  runCode: string | null
  /** ISO 8601 `yyyy-mm-dd`. `null` when `matched` is false. */
  experimentDate: string | null
  /** '' when there is no suffix, otherwise the single suffix letter. `null` when `matched` is false. */
  suffix: string | null
  originalFilename: string
}

function unmatched(originalFilename: string): ParsedRunFilename {
  return { matched: false, runCode: null, experimentDate: null, suffix: null, originalFilename }
}

/** Convert (year, 1-indexed month, day) to an ISO date string, or `null` if it is not a real date. */
function toIsoDateIfValid(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  // Date.UTC normalises out-of-range days (e.g. Feb 30 -> Mar 2), so reading the fields back and
  // comparing against the input is what actually rejects invalid calendar dates.
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null
  }
  const yyyy = String(year).padStart(4, '0')
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Parse a `YYMMDD[a-z]?_data.csv` filename into run metadata.
 *
 * Two-digit years map to `2000 + YY` (this workflow has no runs predating 2000). Non-matching
 * filenames — including ones with an otherwise-well-formed date that doesn't exist, like
 * `260230_data.csv` (Feb 30) — return `matched: false` rather than throwing, so a caller can
 * always fall back to asking the user to supply the run's metadata by hand.
 */
export function parseRunFilename(filename: string): ParsedRunFilename {
  const match = RUN_FILENAME_PATTERN.exec(filename)
  const groups = match?.groups
  if (!groups) return unmatched(filename)

  const datePart = groups.date ?? ''
  const suffixPart = groups.suffix ?? ''

  const twoDigitYear = Number(datePart.slice(0, 2))
  const month = Number(datePart.slice(2, 4))
  const day = Number(datePart.slice(4, 6))
  const year = 2000 + twoDigitYear

  const experimentDate = toIsoDateIfValid(year, month, day)
  if (experimentDate === null) return unmatched(filename)

  return {
    matched: true,
    runCode: `${datePart}${suffixPart}`,
    experimentDate,
    suffix: suffixPart,
    originalFilename: filename,
  }
}

/** The subset of run metadata the gallery sort needs. */
export interface RunGallerySortKey {
  /** ISO `yyyy-mm-dd`, or `null` for a run whose filename didn't parse. */
  experimentDate: string | null
  /** '' for no suffix, or `null` alongside a `null` `experimentDate`. */
  suffix: string | null
  originalFilename: string
}

/**
 * Deterministic gallery ordering: newest experiment date first, then suffix ascending with
 * no-suffix sorting before any lettered suffix ('' < 'a' < 'b' < ..., which plain string
 * comparison already gives). Entries with no parsed date (non-matching filenames) sort after all
 * dated entries, ordered by filename, so unrecognised uploads don't scatter through the gallery.
 */
export function compareRunGalleryEntries(a: RunGallerySortKey, b: RunGallerySortKey): number {
  if (a.experimentDate === null && b.experimentDate === null) {
    return a.originalFilename.localeCompare(b.originalFilename)
  }
  if (a.experimentDate === null) return 1
  if (b.experimentDate === null) return -1

  if (a.experimentDate !== b.experimentDate) {
    return a.experimentDate < b.experimentDate ? 1 : -1 // newest first => descending date order
  }

  const suffixA = a.suffix ?? ''
  const suffixB = b.suffix ?? ''
  if (suffixA === suffixB) return 0
  return suffixA < suffixB ? -1 : 1
}
