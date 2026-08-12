/**
 * Theme resolution and the graph palette.
 *
 * The colours are `Colors.LIGHT_*` / `Colors.DARK_*` from `gui/styles.py`,
 * carried over unchanged. The `GRAPH_*` entries are marked "Frozen (export): do
 * not modify" in the desktop source because they are baked into published
 * figures; the same applies here, and the cloud poster renderer draws with the
 * light set for the same reason.
 *
 * Chrome colours live in CSS custom properties (see `src/styles/tokens.css`).
 * The graph palette has to exist in JavaScript as well because uPlot draws into
 * a canvas, where a CSS variable is not a colour anyone can paint with.
 */

/** What the user asked for. Persisted as `theme` in the analysis config. */
export type ThemeSetting = 'system' | 'light' | 'dark'

/** What is actually painted. `system` never reaches this type. */
export type ResolvedTheme = 'light' | 'dark'

/**
 * Resolve a setting against the platform preference.
 *
 * `system` is not a third palette — it is a deferral, and the deferral has to
 * happen at paint time rather than at save time, because the OS can switch
 * while the app is open.
 */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === 'light') return 'light'
  if (setting === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/** Read the platform preference. Returns `false` where `matchMedia` is absent. */
export function prefersDarkScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export interface GraphPalette {
  /** Plot surface; matches the content background so the graph reads as a panel, not a card. */
  readonly background: string
  readonly grid: string
  readonly axis: string
  readonly textPrimary: string
  readonly textSecondary: string
  readonly border: string
  /** Frozen export colours — see the note in `gui/styles.py`. */
  readonly innerMean: string
  readonly dragMean: string
  readonly innerStd: string
  readonly dragStd: string
  readonly span: string
  readonly highlight: string
  /** Distinct colours for the comparison view, one per dataset trace. */
  readonly comparison: readonly string[]
}

/**
 * The comparison palette.
 *
 * The desktop samples Matplotlib's `tab20`. Reproducing that sampling exactly
 * would be pointless — the number of traces differs per run, so the colours
 * never lined up between two sessions anyway. What matters is that adjacent
 * traces stay distinguishable, including for the most common colour-vision
 * deficiencies, so this is a fixed qualitative ramp used in order.
 */
const COMPARISON_LIGHT = [
  '#0969DA',
  '#CF222E',
  '#1A7F37',
  '#8250DF',
  '#9A6700',
  '#1B7C83',
  '#BF3989',
  '#57606A',
] as const

const COMPARISON_DARK = [
  '#58A6FF',
  '#F85149',
  '#3FB950',
  '#D2A8FF',
  '#D29922',
  '#39C5CF',
  '#DB61A2',
  '#8B949E',
] as const

const LIGHT_PALETTE: GraphPalette = {
  background: '#FFFFFF',
  grid: '#5C6570',
  axis: '#5C6570',
  textPrimary: '#1F2328',
  textSecondary: '#5C6570',
  border: '#DCE1E6',
  innerMean: '#0969DA',
  dragMean: '#CF222E',
  innerStd: '#218BFF',
  dragStd: '#8250DF',
  span: '#0969DA',
  highlight: '#1A7F37',
  comparison: COMPARISON_LIGHT,
}

const DARK_PALETTE: GraphPalette = {
  background: '#0D1117',
  grid: '#9DA7B3',
  axis: '#9DA7B3',
  textPrimary: '#E6EDF3',
  textSecondary: '#9DA7B3',
  border: '#2D343C',
  innerMean: '#58A6FF',
  dragMean: '#F85149',
  innerStd: '#79C0FF',
  dragStd: '#D2A8FF',
  span: '#58A6FF',
  highlight: '#3FB950',
  comparison: COMPARISON_DARK,
}

export function graphPalette(theme: ResolvedTheme): GraphPalette {
  return theme === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
}

/**
 * The palette a saved PNG uses, regardless of the on-screen theme.
 *
 * `PlotController._get_export_palette` fixes a white background for every saved
 * image. A dark-theme figure pasted into a paper is a mistake nobody notices
 * until it is printed.
 */
export function exportPalette(): GraphPalette {
  return LIGHT_PALETTE
}

/** Pick a comparison colour by trace index, wrapping when there are more traces than colours. */
export function comparisonColour(palette: GraphPalette, index: number): string {
  const colours = palette.comparison
  return colours[index % colours.length] as string
}
