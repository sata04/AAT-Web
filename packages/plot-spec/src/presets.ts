/**
 * Poster preset versions: frozen, named visual styles for exported poster figures.
 *
 * A preset is a *data description* — colours, line widths, label templates, default geometry —
 * consumed by the Python/Matplotlib renderer running in the Cloudflare Container. The browser
 * never sends style kwargs; it only ever names a preset version, and the renderer looks up the
 * corresponding frozen constants from here (or its own vendored copy of the same values — see
 * `poster-renderer/`). This is what keeps a poster pixel-compatible with the desktop app's
 * exported PNGs across every render, forever: the style can never drift per-request.
 *
 * `aat-poster-v1` reproduces the desktop app's `PlotController._apply_export_theme` /
 * `plot_gravity_level` export path exactly. Every constant below was verified against:
 *   - /home/user/AAT/gui/plot_controller.py (line colours, widths, grid, watermark, layout, savefig kwargs)
 *   - /home/user/AAT/gui/styles.py (the `LIGHT_GRAPH_*` frozen colour constants)
 *   - /home/user/AAT/tests/gui/test_export_graph_invariance.py (the pinned regression values)
 *   - /home/user/AAT/config/config.default.json (default figure geometry / dpi / x-range / y-range)
 *
 * Changing any value here changes the pixels of every future poster — treat this file with the
 * same "frozen contract" weight `styles.py` gives `LIGHT_GRAPH_*`. If a change is ever needed, it
 * must ship as a *new* preset version (`aat-poster-v2`, ...) so existing stored posters keep
 * rendering the way they always have; `posterPresetContentHash` exists precisely to make an
 * accidental change to `aat-poster-v1` detectable in a test.
 */

import { canonicalStringify, sha256Hex } from './codec.ts'

export const POSTER_PRESET_VERSIONS = ['aat-poster-v1'] as const

export type PosterPresetVersion = (typeof POSTER_PRESET_VERSIONS)[number]

/**
 * The preset every newly created poster is rendered with.
 *
 * Written out as a literal rather than derived from the end of {@link POSTER_PRESET_VERSIONS},
 * because adding a version to that array must never be what changes the style of every new
 * figure. A `v2` will exist for a while before it becomes the default — long enough to render
 * both and compare them — and promoting it is then a one-line, reviewable, deliberate change
 * here. Existing posters are unaffected either way: each stored figure records the version it was
 * rendered with, which is the whole reason the presets are versioned rather than edited.
 */
export const DEFAULT_POSTER_PRESET_VERSION: PosterPresetVersion = 'aat-poster-v1'

export interface PosterLineStyle {
  color: string
  /** Omitted where the desktop app never overrides Matplotlib's default line width. */
  lineWidth?: number
}

export interface PosterWatermarkSpec {
  /** Literal `{version}` is replaced with the renderer/app version, e.g. "AAT v11.1.0". */
  textTemplate: string
  /** Axes-fraction coordinates (0..1), matching `ax.transAxes` in the Python source. */
  x: number
  y: number
  horizontalAlignment: 'left' | 'center' | 'right'
  verticalAlignment: 'top' | 'center' | 'bottom'
  fontSize: number
  color: string
}

export interface PosterLabelsSpec {
  /** Literal `{name}` is replaced with the run's display name. */
  titleTemplate: string
  xLabel: string
  yLabel: string
}

export interface PosterDefaultsSpec {
  xMin: number
  xMax: number
  /**
   * Gravity level (G). The desktop's `config.default.json` `ylim_min` / `ylim_max`.
   *
   * These are defaults in the same sense as {@link xMin} / {@link xMax}: a value the spec may
   * override, never a value the spec may *drop*. `plot_gravity_level` calls
   * `set_ylim(config["ylim_min"], config["ylim_max"])` unconditionally on both the screen axes and
   * the export axes — there is no branch in the desktop application where Matplotlib autoscales
   * the y-axis of a gravity-level figure, so there is none here either.
   *
   * A fixed frame is what makes these figures comparable, which is the entire reason a poster is
   * rendered from a frozen preset rather than screenshotted. Autoscaling to the data would give a
   * clean 5 mG drop and a spoiled 400 mG drop the same-looking plateau, differing only in the tick
   * labels — the one visual comparison a reader of a poster is most likely to make by eye.
   */
  yMin: number
  yMax: number
  figureWidth: number
  figureHeight: number
  dpi: number
  /** Always `null` — the desktop export never passes `bbox_inches="tight"`. */
  bboxInches: null
  tightLayout: true
}

export interface PosterPreset {
  version: PosterPresetVersion
  figure: { faceColor: string }
  axes: { faceColor: string }
  lines: {
    innerMean: PosterLineStyle
    dragMean: PosterLineStyle
    innerStd: PosterLineStyle
    dragStd: PosterLineStyle
  }
  grid: { lineStyle: string; alpha: number; color: string }
  spine: { color: string }
  ticks: { color: string }
  text: { axisLabelColor: string; titleColor: string }
  legend: { faceColor: string; edgeColor: string; textColor: string }
  watermark: PosterWatermarkSpec
  labels: PosterLabelsSpec
  defaults: PosterDefaultsSpec
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}

/**
 * Recursively `readonly`, so the frozen visual contract is un-mutable at the
 * type level as well as at runtime.
 *
 * `deepFreeze` alone only fails on assignment at runtime, and only in strict
 * mode. Since these values decide what every published research figure looks
 * like, an accidental mutation should be a compile error, not a surprise in
 * production.
 */
type DeepReadonly<T> = T extends (infer Element)[]
  ? ReadonlyArray<DeepReadonly<Element>>
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T

/** The frozen `aat-poster-v1` style. See the module doc for the source-of-truth files. */
export const AAT_POSTER_V1_PRESET: DeepReadonly<PosterPreset> = deepFreeze({
  version: 'aat-poster-v1',
  figure: { faceColor: '#FFFFFF' },
  axes: { faceColor: '#FFFFFF' },
  lines: {
    // EXPORT_LINEWIDTH_GL in test_export_graph_invariance.py; the Gravity Level mean traces only —
    // the G-quality mean/std traces are never given an explicit width in plot_controller.py.
    innerMean: { color: '#0969DA', lineWidth: 0.8 },
    dragMean: { color: '#CF222E', lineWidth: 0.8 },
    innerStd: { color: '#218BFF' },
    dragStd: { color: '#8250DF' },
  },
  grid: { lineStyle: '--', alpha: 0.3, color: '#656D76' },
  spine: { color: '#D0D7DE' },
  ticks: { color: '#656D76' },
  text: { axisLabelColor: '#1F2328', titleColor: '#1F2328' },
  legend: { faceColor: '#FFFFFF', edgeColor: '#D0D7DE', textColor: '#1F2328' },
  watermark: {
    textTemplate: 'AAT v{version}',
    x: 0.98,
    y: 0.02,
    horizontalAlignment: 'right',
    verticalAlignment: 'bottom',
    fontSize: 8,
    color: '#656D76',
  },
  labels: {
    titleTemplate: 'The Gravity Level {name}',
    xLabel: 'Time (s)',
    yLabel: 'Gravity Level (G)',
  },
  defaults: {
    xMin: 0,
    xMax: 1.45,
    yMin: -1,
    yMax: 1,
    figureWidth: 10.6,
    figureHeight: 3.4,
    dpi: 300,
    bboxInches: null,
    tightLayout: true,
  },
})

export const POSTER_PRESETS: Readonly<Record<PosterPresetVersion, PosterPreset>> = deepFreeze({
  'aat-poster-v1': AAT_POSTER_V1_PRESET,
})

export function getPosterPreset(version: PosterPresetVersion): PosterPreset {
  return POSTER_PRESETS[version]
}

/**
 * Whether a string names a preset this build knows.
 *
 * Exists because preset versions outlive the code that reads them in both directions: a browser
 * holds a chosen version in local settings, and a deployment can be rolled back to a build that
 * predates it. Checking a stored or received string here turns "the poster dialog throws on open"
 * into "fall back to {@link DEFAULT_POSTER_PRESET_VERSION}".
 */
export function isPosterPresetVersion(value: unknown): value is PosterPresetVersion {
  return typeof value === 'string' && (POSTER_PRESET_VERSIONS as readonly string[]).includes(value)
}

/**
 * Stable content hash of a preset's constants (canonical JSON, SHA-256, lowercase hex). Assert
 * this against a hardcoded value in a test: if it ever changes, `aat-poster-v1`'s frozen contract
 * was broken and the change must instead become a new preset version.
 */
export async function posterPresetContentHash(preset: PosterPreset): Promise<string> {
  return sha256Hex(canonicalStringify(preset as unknown as Record<string, unknown>))
}
