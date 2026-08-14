/**
 * Shared contract for keyboard-reachable table overflow.
 *
 * A table can be wider than its panel, especially on a phone. The wrapper owns the horizontal
 * scroll, so it also has to be focusable; otherwise keyboard users cannot reach hidden columns.
 * Keeping both attributes together prevents a new table from silently restoring axe's
 * `scrollable-region-focusable` violation.
 */
export const TABLE_SCROLL_PROPS = { className: 'table-scroll', tabIndex: 0 } as const
