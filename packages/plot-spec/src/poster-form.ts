/**
 * The bounded choices a custom-poster form may offer, defined here so the browser cannot invent
 * its own and drift away from what the renderer accepts.
 *
 * `spec.ts` bounds figure geometry to 2–20 inches and DPI to 72–600, which is the range a
 * *validator* must allow: it is defending a Python container against a hostile body, not designing
 * a form. A form built directly on those bounds would be two free numeric fields, and free numeric
 * fields are how a researcher ends up with a 3.1 × 19.7 inch poster at 583 dpi that does not sit
 * next to last month's figure on the same page. Formal figures are comparable because they are
 * uniform, so the UI offers a short list of sizes and resolutions and nothing else.
 *
 * Every default here is *derived from the frozen preset* rather than restated, so the simplest
 * custom poster — the user opens the dialog, picks a range, presses render — comes out in exactly
 * the style of the automatic poster and of the desktop application's own export. If `presets.ts`
 * ever ships a `v2` with different geometry, the default option follows it without an edit here,
 * and `poster-form.test.ts` asserts that the derived option is present and correct.
 *
 * Labels carry both locales for the same reason `errors.ts` does: Japanese is the application's
 * language, English is carried alongside rather than bolted on later. They deliberately do not
 * contain the numbers — a UI renders `10.6 × 3.4 in` from the fields, so a label can never
 * disagree with the value it labels.
 */

import type { PosterSpecLocale } from './errors.ts'
import { DEFAULT_POSTER_PRESET_VERSION, getPosterPreset, type PosterPresetVersion } from './presets.ts'
import type { SeriesSelection } from './spec.ts'

type LocalisedLabel = Readonly<Record<PosterSpecLocale, string>>

// ---------------------------------------------------------------------------------------------
// Figure size
// ---------------------------------------------------------------------------------------------

/**
 * Stable identifiers for the offered figure sizes. Stable because a UI stores the chosen id in
 * local settings and a stored `'a4-landscape'` must keep meaning A4 landscape across releases —
 * which is also why these are names rather than indices into a list that may grow.
 */
export type PosterFigureSizeId = 'preset' | 'slide' | 'a4-landscape' | 'compact'

export interface PosterFigureSizeOption {
  readonly id: PosterFigureSizeId
  readonly label: LocalisedLabel
  /** Inches, as Matplotlib's `figsize` takes them. Always within `spec.ts`'s dimension bounds. */
  readonly widthInches: number
  readonly heightInches: number
}

/** The option a form starts on: the frozen preset's own geometry. */
export const DEFAULT_POSTER_FIGURE_SIZE_ID: PosterFigureSizeId = 'preset'

/**
 * The three sizes offered besides the preset's own.
 *
 * Each exists for a destination a researcher in this project actually has, and none of them is a
 * round number chosen for looking tidy:
 *
 *  - **slide** — 13.33 × 7.5 in is 1280 × 720 at 96 dpi, i.e. a 16:9 presentation slide at exactly
 *    one device pixel per point. A poster dropped into a talk at any other aspect ratio gets
 *    letterboxed or, worse, stretched by the presentation software.
 *  - **a4-landscape** — 11.69 × 8.27 in is A4's long edge by its short edge. A figure printed for
 *    a poster session or pinned in the lab is printed on A4 here, and sizing the figure to the
 *    paper rather than scaling it at print time keeps the line widths and font sizes that the
 *    frozen preset pins in *points* meaning what they were set to mean.
 *  - **compact** — 6.4 × 4.8 in is Matplotlib's own default figure size, which is what a
 *    single-column journal figure is generally prepared at. It is the only offered size that is
 *    taller than it is wide by much, and it exists so a figure destined for a paper is not a
 *    shrunk-down wide strip with unreadable axes.
 *
 * The preset's own geometry (10.6 × 3.4 in — the desktop export's wide strip, which shows a 1.45 s
 * drop with the vertical detail the microgravity plateau needs) is not listed here because it is
 * derived from the preset at call time by {@link posterFigureSizeOptions}.
 */
const ADDITIONAL_FIGURE_SIZES: readonly PosterFigureSizeOption[] = [
  {
    id: 'slide',
    label: { ja: 'スライド (16:9)', en: 'Slide (16:9)' },
    widthInches: 13.33,
    heightInches: 7.5,
  },
  {
    id: 'a4-landscape',
    label: { ja: 'A4 横', en: 'A4 landscape' },
    widthInches: 11.69,
    heightInches: 8.27,
  },
  {
    id: 'compact',
    label: { ja: '小 (論文の段組み向け)', en: 'Compact (journal column)' },
    widthInches: 6.4,
    heightInches: 4.8,
  },
]

/**
 * The figure sizes a form may offer, for a given preset version.
 *
 * The first entry is always the preset's own geometry, read from
 * `getPosterPreset(version).defaults` so that it cannot drift from what the automatic poster and
 * the desktop export use — that is the entire reason this is a function of the preset version
 * rather than a frozen array.
 */
export function posterFigureSizeOptions(
  version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION,
): readonly PosterFigureSizeOption[] {
  const { defaults } = getPosterPreset(version)
  return [
    {
      id: 'preset',
      label: { ja: '標準 (デスクトップ版と同じ)', en: 'Standard (same as the desktop export)' },
      widthInches: defaults.figureWidth,
      heightInches: defaults.figureHeight,
    },
    ...ADDITIONAL_FIGURE_SIZES,
  ]
}

/** Look up one offered size by id. Returns `undefined` for an id a stored setting no longer names. */
export function findPosterFigureSize(
  id: string,
  version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION,
): PosterFigureSizeOption | undefined {
  return posterFigureSizeOptions(version).find((option) => option.id === id)
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

export interface PosterDpiOption {
  readonly dpi: number
  /**
   * The purpose, not the number. A UI writes `300 dpi — 標準`; putting "300" in the label too
   * would let the two halves disagree.
   */
  readonly label: LocalisedLabel
}

/**
 * The resolutions offered, all inside `spec.ts`'s `DPI_MIN`/`DPI_MAX`.
 *
 * Three, because there are three destinations and rendering is not free — every option is a
 * container render charged against the user's quota, and a fourth choice between 300 and 600 would
 * cost real time to produce a figure nobody could tell apart from its neighbours.
 *
 *  - **150** is a draft: quick to render, small to download, readable on screen, and obviously not
 *    a final figure if it is ever mistaken for one.
 *  - **300** is the preset's own value and the desktop export's, and the long-standing floor for
 *    print in journals and poster sessions. It is the default for that reason and no other.
 *  - **600** is the ceiling a print shop asks for on a large-format poster. It is roughly four
 *    times the pixels of 300 for a figure this size, which is why it is a choice rather than the
 *    default.
 *
 * The preset's own DPI is guaranteed present in the returned list by
 * {@link posterDpiOptions} — if a future preset defaults to something not listed here, that value
 * is inserted rather than silently unavailable.
 */
const BASE_DPI_OPTIONS: readonly PosterDpiOption[] = [
  { dpi: 150, label: { ja: '下書き', en: 'Draft' } },
  { dpi: 300, label: { ja: '標準 (印刷・投稿向け)', en: 'Standard (print and submission)' } },
  { dpi: 600, label: { ja: '高解像度 (大判印刷向け)', en: 'High resolution (large-format print)' } },
]

/**
 * The resolutions a form may offer, ascending, always including the preset's own default so the
 * form can never fail to offer the value the automatic poster uses.
 */
export function posterDpiOptions(
  version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION,
): readonly PosterDpiOption[] {
  const presetDpi = getPosterPreset(version).defaults.dpi
  if (BASE_DPI_OPTIONS.some((option) => option.dpi === presetDpi)) return BASE_DPI_OPTIONS
  return [
    ...BASE_DPI_OPTIONS,
    {
      dpi: presetDpi,
      label: { ja: '標準 (デスクトップ版と同じ)', en: 'Standard (same as the desktop export)' },
    },
  ].sort((left, right) => left.dpi - right.dpi)
}

// ---------------------------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------------------------

export interface PosterSeriesOption {
  readonly value: SeriesSelection
  readonly label: LocalisedLabel
}

/**
 * Which sensors to draw. The Japanese wording matches the graph's own sensor-mode selector in
 * `SettingsDialog.tsx` ("両方" / "Inner Capsule のみ" / "Drag Shield のみ") so that the same choice
 * is not named two different things two screens apart. The sensor names themselves stay in
 * English in both locales — they are the equipment's names, and the desktop application, the
 * legend of every exported figure and the Excel sheets all spell them this way.
 */
export const POSTER_SERIES_OPTIONS: readonly PosterSeriesOption[] = [
  { value: 'both', label: { ja: '両方', en: 'Both sensors' } },
  { value: 'inner', label: { ja: 'Inner Capsule のみ', en: 'Inner Capsule only' } },
  { value: 'drag', label: { ja: 'Drag Shield のみ', en: 'Drag Shield only' } },
]

// ---------------------------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------------------------

/**
 * The name the renderer substitutes into the frozen title and legend templates.
 *
 * This mirrors `PosterPlotSpec.display_name` in `poster-renderer/src/poster_renderer/validation.py`
 * exactly, and it is the single most misreadable field in the whole spec: `title` is **not** the
 * poster's title. The frozen contract draws the title as "The Gravity Level <name>" and the legend
 * entries as "<name> (Inner Capsule)" / "<name> (Drag Shield)" — one name in three places — and
 * `title` replaces that *name*, never the template. An empty `title` (the default) means "no
 * override", and the run code is used, which is what the desktop application does with its CSV
 * basename.
 *
 * A UI that labels this field "タイトル" and shows the user's text as the whole title is lying
 * about what it will render; label it as the figure's name and preview the result with
 * {@link posterTitleLine}.
 */
export function posterDisplayName(runCode: string, title = ''): string {
  return title === '' ? runCode : title
}

/**
 * The exact title line the renderer will draw, so a form can show it live instead of describing
 * it. Built from the preset's own `titleTemplate`, so a future preset that retitles its figures
 * retitles this preview with it.
 */
export function posterTitleLine(
  runCode: string,
  title = '',
  version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION,
): string {
  const { labels } = getPosterPreset(version)
  const name = posterDisplayName(runCode, title)
  // A replacer function, not a replacement string: `String.replaceAll` gives `$&`, `$'` and
  // friends a special meaning in a replacement string, so a figure named "$&" would preview as
  // something other than itself. The Python renderer's `str.format` has no such rule, and the
  // preview must show exactly what will be drawn.
  return labels.titleTemplate.replaceAll('{name}', () => name)
}

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

/** The state a freshly opened custom-poster form starts in. */
export interface PosterFormDefaults {
  readonly posterPresetVersion: PosterPresetVersion
  readonly series: SeriesSelection
  readonly showLegend: boolean
  /** Empty: no name override, so the poster is titled from the run code. */
  readonly title: string
  readonly figureSizeId: PosterFigureSizeId
  readonly figureWidth: number
  readonly figureHeight: number
  readonly dpi: number
}

/**
 * The initial values for a custom-poster form.
 *
 * Every one of them is the frozen preset's, so a user who changes nothing gets the automatic
 * poster's style over their own chosen range — which is the point of offering a custom poster at
 * all. `showLegend` is true because the desktop export always draws a legend, and a two-sensor
 * figure without one cannot be read; `series` is `'both'` for the same reason the graph's default
 * sensor mode is `'both'` — showing everything can mislead nobody.
 */
export function posterFormDefaults(
  version: PosterPresetVersion = DEFAULT_POSTER_PRESET_VERSION,
): PosterFormDefaults {
  const { defaults } = getPosterPreset(version)
  return {
    posterPresetVersion: version,
    series: 'both',
    showLegend: true,
    title: '',
    figureSizeId: DEFAULT_POSTER_FIGURE_SIZE_ID,
    figureWidth: defaults.figureWidth,
    figureHeight: defaults.figureHeight,
    dpi: defaults.dpi,
  }
}
