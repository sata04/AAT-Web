/**
 * Number formatting for the results tables.
 *
 * Port of `gui/formatting.py::fmt`. The em dash for an absent value is not
 * cosmetic: printing `0.0000` for a statistic that could not be computed is a
 * measurement claim nobody made, and `NaN` in a results table invites someone to
 * copy it into a paper.
 */

const EM_DASH = '—'

/** `fmt(value, ".4f")` — fixed decimals, em dash for null/NaN/Infinity. */
export function formatFixed(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH
  return value.toFixed(digits)
}

/** Counts are integers; rendering `3.000000` misrepresents what the number is. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH
  return String(Math.trunc(value))
}

/** Time values use three decimals, matching the desktop's `fmt(..., ".3f")`. */
export function formatSeconds(value: number | null | undefined): string {
  return formatFixed(value, 3)
}

/** Byte sizes for the file list. Binary units, because that is what storage reports. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return EM_DASH
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

export { EM_DASH }
