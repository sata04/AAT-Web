/**
 * Formula-injection defence for spreadsheet exports (`core/export.py`'s Excel output and any
 * future CSV export).
 *
 * Excel, Sheets and LibreOffice all treat a TEXT cell whose content starts with `=`, `+`, `-` or
 * `@` as a formula, and a leading tab or carriage return before one of those characters does not
 * reliably stop that interpretation either. A CSV column value containing user-supplied or
 * device-supplied text (a filename, a free-text note) could otherwise execute as a formula the
 * moment the exported file is opened. Prefixing a defusing apostrophe forces spreadsheet
 * applications to treat the cell as literal text while leaving the visible content unchanged.
 *
 * This must only ever be applied to TEXT cells. Numeric series (gravity, time, statistics) must
 * never be routed through this function — coercing a number to a string here would silently turn
 * a numeric cell into a text cell in the output, breaking any formula a user builds against it.
 */

const DANGEROUS_LEADING_CHARACTERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Prefix a defusing apostrophe if `value` would otherwise be interpreted as a spreadsheet formula.
 * Values not starting with a dangerous character (including the empty string) are returned as-is.
 */
export function sanitiseTextCell(value: string): string {
  if (value.length === 0) return value
  const first = value.charAt(0)
  return DANGEROUS_LEADING_CHARACTERS.has(first) ? `'${value}` : value
}
