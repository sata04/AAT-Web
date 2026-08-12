/**
 * The view-mode state machine — a port of `gui/view_mode.py`.
 *
 * The desktop app replaced three independent booleans (`is_comparing`,
 * `is_showing_all`, `is_g_quality_mode`) with a single enum precisely because
 * the booleans could reach combinations that no code path knew how to draw:
 * "showing all" *and* "G-quality" at once is not a view, it is a bug waiting for
 * a redraw. Six named states can only ever be one of six things.
 *
 * This port keeps that property and goes one step further: the transition table
 * is total. Every (state, event) pair has an explicit answer, so a state can
 * never be reached by falling through a conditional nobody updated.
 *
 * `ENTER_COMPARING` and `LEAVE_COMPARING` reproduce the Python dictionaries
 * exactly, including their `dict.get(mode, default)` behaviour for the states
 * they do not list.
 */

export const VIEW_MODES = [
  'NORMAL',
  'SHOW_ALL',
  'G_QUALITY',
  'COMPARING',
  'COMPARING_SHOW_ALL',
  'COMPARING_G_QUALITY',
] as const

export type ViewMode = (typeof VIEW_MODES)[number]

/**
 * `ENTER_COMPARING` in `gui/view_mode.py` — the same three entries, no more.
 *
 * The comparing states are deliberately absent, matching the Python: the
 * desktop reaches this only from `toggle_comparison`, which never calls it
 * while already comparing.
 */
export const ENTER_COMPARING: Readonly<Partial<Record<ViewMode, ViewMode>>> = {
  NORMAL: 'COMPARING',
  SHOW_ALL: 'COMPARING_SHOW_ALL',
  G_QUALITY: 'COMPARING_G_QUALITY',
}

/** `LEAVE_COMPARING` in `gui/view_mode.py`. */
export const LEAVE_COMPARING: Readonly<Partial<Record<ViewMode, ViewMode>>> = {
  COMPARING: 'NORMAL',
  COMPARING_SHOW_ALL: 'SHOW_ALL',
  COMPARING_G_QUALITY: 'G_QUALITY',
}

/**
 * Events the UI can raise.
 *
 * Show-all and G-quality are expressed as explicit ON/OFF rather than "toggle",
 * because the desktop reads the *checked state of the button* and not the
 * previous mode — a toggle event would reintroduce the ambiguity the enum was
 * introduced to remove.
 */
export type ViewEvent =
  | 'ENTER_COMPARING'
  | 'LEAVE_COMPARING'
  | 'SHOW_ALL_ON'
  | 'SHOW_ALL_OFF'
  | 'G_QUALITY_ON'
  | 'G_QUALITY_OFF'

/**
 * The complete transition table, written out rather than computed.
 *
 * Reading it top to bottom is the audit: every row is one state, every column
 * one event, and there is no cell whose answer has to be inferred.
 *
 * Two behaviours worth naming because they come straight from the desktop:
 *   - `SHOW_ALL_ON` from `G_QUALITY` lands in `SHOW_ALL`, not in some combined
 *     state. The two are mutually exclusive; `toggle_show_all_data` writes the
 *     mode unconditionally, and the show-all control is hidden while G-quality
 *     is active so the user cannot normally get here at all.
 *   - `SHOW_ALL_OFF` / `G_QUALITY_OFF` return to `NORMAL` or `COMPARING`
 *     depending only on whether comparison is active, exactly as the Python's
 *     `ViewMode.COMPARING if self.is_comparing else ViewMode.NORMAL` does.
 */
export const TRANSITIONS: Readonly<Record<ViewMode, Readonly<Record<ViewEvent, ViewMode>>>> = {
  NORMAL: {
    ENTER_COMPARING: 'COMPARING',
    LEAVE_COMPARING: 'NORMAL',
    SHOW_ALL_ON: 'SHOW_ALL',
    SHOW_ALL_OFF: 'NORMAL',
    G_QUALITY_ON: 'G_QUALITY',
    G_QUALITY_OFF: 'NORMAL',
  },
  SHOW_ALL: {
    ENTER_COMPARING: 'COMPARING_SHOW_ALL',
    LEAVE_COMPARING: 'SHOW_ALL',
    SHOW_ALL_ON: 'SHOW_ALL',
    SHOW_ALL_OFF: 'NORMAL',
    G_QUALITY_ON: 'G_QUALITY',
    G_QUALITY_OFF: 'NORMAL',
  },
  G_QUALITY: {
    ENTER_COMPARING: 'COMPARING_G_QUALITY',
    LEAVE_COMPARING: 'G_QUALITY',
    SHOW_ALL_ON: 'SHOW_ALL',
    SHOW_ALL_OFF: 'NORMAL',
    G_QUALITY_ON: 'G_QUALITY',
    G_QUALITY_OFF: 'NORMAL',
  },
  COMPARING: {
    ENTER_COMPARING: 'COMPARING',
    LEAVE_COMPARING: 'NORMAL',
    SHOW_ALL_ON: 'COMPARING_SHOW_ALL',
    SHOW_ALL_OFF: 'COMPARING',
    G_QUALITY_ON: 'COMPARING_G_QUALITY',
    G_QUALITY_OFF: 'COMPARING',
  },
  COMPARING_SHOW_ALL: {
    ENTER_COMPARING: 'COMPARING',
    LEAVE_COMPARING: 'SHOW_ALL',
    SHOW_ALL_ON: 'COMPARING_SHOW_ALL',
    SHOW_ALL_OFF: 'COMPARING',
    G_QUALITY_ON: 'COMPARING_G_QUALITY',
    G_QUALITY_OFF: 'COMPARING',
  },
  COMPARING_G_QUALITY: {
    ENTER_COMPARING: 'COMPARING',
    LEAVE_COMPARING: 'G_QUALITY',
    SHOW_ALL_ON: 'COMPARING_SHOW_ALL',
    SHOW_ALL_OFF: 'COMPARING',
    G_QUALITY_ON: 'COMPARING_G_QUALITY',
    G_QUALITY_OFF: 'COMPARING',
  },
}

/** Apply an event. Total: every state answers every event. */
export function transition(mode: ViewMode, event: ViewEvent): ViewMode {
  return TRANSITIONS[mode][event]
}

/** `ENTER_COMPARING.get(mode, ViewMode.COMPARING)` in the Python. */
export function enterComparing(mode: ViewMode): ViewMode {
  return ENTER_COMPARING[mode] ?? 'COMPARING'
}

/** `LEAVE_COMPARING.get(mode, ViewMode.NORMAL)` in the Python. */
export function leaveComparing(mode: ViewMode): ViewMode {
  return LEAVE_COMPARING[mode] ?? 'NORMAL'
}

/** `MainWindow.is_comparing`. */
export function isComparing(mode: ViewMode): boolean {
  return mode === 'COMPARING' || mode === 'COMPARING_SHOW_ALL' || mode === 'COMPARING_G_QUALITY'
}

/** `MainWindow.is_showing_all`. */
export function isShowingAll(mode: ViewMode): boolean {
  return mode === 'SHOW_ALL' || mode === 'COMPARING_SHOW_ALL'
}

/** `MainWindow.is_g_quality_mode`. */
export function isGQuality(mode: ViewMode): boolean {
  return mode === 'G_QUALITY' || mode === 'COMPARING_G_QUALITY'
}

/**
 * Whether range selection is available.
 *
 * The desktop attaches a `SpanSelector` in `plot_gravity_level` only, and every
 * other draw path calls `clear_span_selectors()`. So: the plain single-dataset
 * gravity view, and nothing else. Selecting a span across a comparison of four
 * datasets, or across a window-size axis, has no meaning to compute statistics
 * over.
 */
export function canSelectRange(mode: ViewMode): boolean {
  return mode === 'NORMAL'
}

/**
 * Whether the x axis is pinned to `default_graph_duration`.
 *
 * Show-all exists to reveal what filtering removed, including negative time, so
 * it must not be clipped. The comparison view keeps the fixed window so several
 * runs stay comparable — both straight from `plot_controller.py`.
 */
export function usesFixedDuration(mode: ViewMode): boolean {
  return mode === 'NORMAL' || mode === 'COMPARING'
}
