/**
 * AAT analysis configuration: the subset of `core/config.py`'s settings that steer the numeric
 * pipeline (sync detection, gravity conversion, filtering, statistics, G-quality) or how results
 * are presented. Column-mapping keys (`time_column`, `acceleration_column_*`,
 * `use_inner_acceleration`, `use_drag_acceleration`) and `app_version` are deliberately excluded
 * from this schema: they describe a *specific CSV's* column layout rather than an analysis
 * configuration, and are handled per-upload by the CSV/column-detection layer instead. See
 * {@link migrateDesktopConfig} for how those keys are carried through a desktop migration anyway.
 *
 * Defaults below are frozen to match `config/config.default.json` in the desktop app; changing
 * any of them is a behavioural change to the analysis engine, not a config-schema change.
 */

import { z } from 'zod'
import { sha256Hex } from './hash.ts'

/** Coerce numeric strings ("0.1") the way `core/config.py::_coerce_value` does; leave booleans alone. */
function coerceToNumber(value: unknown): unknown {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return value
}

function numberField(options: { min: number; max: number; integer?: boolean }, defaultValue: number) {
  const base = options.integer ? z.number().int() : z.number()
  return z.preprocess(coerceToNumber, base.min(options.min).max(options.max)).default(defaultValue)
}

/** Coerce case/whitespace the way `core/config.py::_coerce_value`'s "choice" kind does. */
function choiceField<T extends [string, ...string[]]>(choices: T, defaultValue: T[number]) {
  return z
    .preprocess((value) => (typeof value === 'string' ? value.trim().toLowerCase() : value), z.enum(choices))
    .default(defaultValue)
}

const bboxField = z
  .preprocess(
    (value) => {
      if (value === null || value === undefined) return null
      if (typeof value === 'string' && value.trim().toLowerCase() === 'tight') return 'tight'
      return value
    },
    z.union([z.null(), z.literal('tight')]),
  )
  .default(null)

export const AnalysisConfigSchema = z.object({
  sampling_rate: numberField({ min: 1, max: 10_000_000, integer: true }, 1000),
  gravity_constant: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 9.797578),
  ylim_min: numberField({ min: -1e6, max: 1e6 }, -1.0),
  ylim_max: numberField({ min: -1e6, max: 1e6 }, 1.0),
  acceleration_threshold: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 5.0),
  end_gravity_level: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 8.0),
  window_size: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 0.1),
  g_quality_start: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 0.1),
  g_quality_end: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 1.0),
  g_quality_step: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 0.05),
  min_seconds_after_start: numberField({ min: 0, max: Number.POSITIVE_INFINITY }, 0.7),
  auto_calculate_g_quality: z.boolean().default(true),
  use_cache: z.boolean().default(true),
  default_graph_duration: numberField({ min: 1e-9, max: Number.POSITIVE_INFINITY }, 1.45),
  graph_sensor_mode: choiceField(['both', 'inner_only', 'drag_only'], 'both'),
  theme: choiceField(['system', 'light', 'dark'], 'system'),
  export_figure_width: numberField({ min: 1.0, max: 100.0 }, 10.6),
  export_figure_height: numberField({ min: 1.0, max: 100.0 }, 3.4),
  export_dpi: numberField({ min: 50, max: 1200, integer: true }, 300),
  export_bbox_inches: bboxField,
  invert_inner_acceleration: z.boolean().default(true),
})

export type AnalysisConfig = z.infer<typeof AnalysisConfigSchema>

/** The frozen default configuration, i.e. `AnalysisConfigSchema.parse({})`. */
export const DEFAULT_ANALYSIS_CONFIG: Readonly<AnalysisConfig> = Object.freeze(AnalysisConfigSchema.parse({}))

/**
 * Keys whose value can change the *numbers* an analysis produces (sync point, gravity values,
 * filtered range, statistics, G-quality rows). Used by {@link configHash} to build a cache key
 * that ignores purely cosmetic settings.
 *
 * Excluded, and why:
 *  - `ylim_min` / `ylim_max` — graph axis limits, display only.
 *  - `theme` — UI colour scheme.
 *  - `export_figure_width` / `export_figure_height` / `export_dpi` / `export_bbox_inches` — PNG
 *    export rendering only, do not touch computed values.
 *  - `default_graph_duration` — initial graph zoom window, display only.
 *  - `graph_sensor_mode` — which sensor's trace is drawn; both sensors are still analysed.
 *  - `use_cache` — controls the desktop app's own cache usage, not a property of the analysis.
 */
export const NUMERIC_RESULT_CONFIG_KEYS = [
  'sampling_rate',
  'gravity_constant',
  'acceleration_threshold',
  'end_gravity_level',
  'window_size',
  'g_quality_start',
  'g_quality_end',
  'g_quality_step',
  'min_seconds_after_start',
  'auto_calculate_g_quality',
  'invert_inner_acceleration',
] as const satisfies readonly (keyof AnalysisConfig)[]

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * Stable SHA-256 over the numeric-result-affecting subset of `config`, sorted keys, hex-encoded.
 * Two configs that would produce identical analysis output hash identically, even if their
 * presentation-only fields (theme, axis limits, export DPI, ...) differ.
 */
export async function configHash(config: AnalysisConfig): Promise<string> {
  const relevant: Record<string, unknown> = {}
  for (const key of NUMERIC_RESULT_CONFIG_KEYS) relevant[key] = config[key]
  return sha256Hex(canonicalJson(relevant))
}

export interface ConfigMigrationWarning {
  /** The desktop config key this warning is about, or '<root>' for whole-document problems. */
  key: string
  message: string
}

export interface ConfigMigrationResult {
  /** The validated web analysis config, with every invalid/missing field replaced by its default. */
  config: AnalysisConfig
  /** Non-fatal problems encountered, in the order they were found. */
  warnings: ConfigMigrationWarning[]
  /**
   * Desktop keys that have no equivalent in {@link AnalysisConfigSchema} (column mappings,
   * unknown/legacy keys). Also includes `app_version`, which is surfaced separately via
   * `sourceAppVersion` but still listed here for a complete "what didn't make it across" summary.
   */
  droppedKeys: string[]
  /** Raw values of every dropped key (excluding `app_version`), preserved for other layers to use. */
  passthrough: Record<string, unknown>
  /** The desktop app's `app_version` field, if present. */
  sourceAppVersion: string | null
}

/**
 * Migrate a desktop `config.json` (snake_case, may include `app_version` and unknown/legacy keys)
 * into a validated web {@link AnalysisConfig}.
 *
 * Mirrors `core/config.py::validate_config`'s philosophy: never throw on bad input. An invalid or
 * out-of-range value falls back to the default field-by-field (not fails-the-whole-document), and
 * every fallback is reported as a warning so the caller can tell the user what changed.
 */
export function migrateDesktopConfig(json: unknown): ConfigMigrationResult {
  const warnings: ConfigMigrationWarning[] = []
  const droppedKeys: string[] = []
  const passthrough: Record<string, unknown> = {}
  let sourceAppVersion: string | null = null

  const isPlainObject = json !== null && typeof json === 'object' && !Array.isArray(json)
  if (!isPlainObject) {
    warnings.push({
      key: '<root>',
      message: 'Desktop config is not a JSON object; using all-default analysis configuration.',
    })
  }
  const source: Record<string, unknown> = isPlainObject ? (json as Record<string, unknown>) : {}

  const shape = AnalysisConfigSchema.shape
  const validatedFields: Record<string, unknown> = {}

  for (const key of Object.keys(shape) as (keyof AnalysisConfig)[]) {
    if (!(key in source)) continue // absent entirely -> let AnalysisConfigSchema.parse() default it
    const fieldSchema = shape[key]
    const parsed = fieldSchema.safeParse(source[key])
    if (parsed.success) {
      validatedFields[key] = parsed.data
    } else {
      warnings.push({
        key,
        message: `Invalid value for "${key}" (${JSON.stringify(source[key])}); using the default instead.`,
      })
    }
  }

  for (const [key, value] of Object.entries(source)) {
    if (key === 'app_version') {
      sourceAppVersion = typeof value === 'string' ? value : JSON.stringify(value)
      droppedKeys.push(key)
      continue
    }
    if (key in shape) continue
    droppedKeys.push(key)
    passthrough[key] = value
  }

  let config = AnalysisConfigSchema.parse(validatedFields)

  // Cross-field consistency, mirroring core/config.py::validate_config's combination checks:
  // individually valid values can still be jointly nonsensical.
  if (config.ylim_min >= config.ylim_max) {
    warnings.push({
      key: 'ylim_min/ylim_max',
      message: 'ylim_min is not less than ylim_max; resetting both to their defaults.',
    })
    config = {
      ...config,
      ylim_min: DEFAULT_ANALYSIS_CONFIG.ylim_min,
      ylim_max: DEFAULT_ANALYSIS_CONFIG.ylim_max,
    }
  }

  if (config.g_quality_start > config.g_quality_end) {
    warnings.push({
      key: 'g_quality_start/g_quality_end',
      message: 'g_quality_start is greater than g_quality_end; resetting both to their defaults.',
    })
    config = {
      ...config,
      g_quality_start: DEFAULT_ANALYSIS_CONFIG.g_quality_start,
      g_quality_end: DEFAULT_ANALYSIS_CONFIG.g_quality_end,
    }
  }

  const gQualitySpan = config.g_quality_end - config.g_quality_start
  if (gQualitySpan > 0 && config.g_quality_step > gQualitySpan) {
    warnings.push({
      key: 'g_quality_step',
      message: 'g_quality_step is larger than the scan range; clamping it to the range.',
    })
    config = { ...config, g_quality_step: gQualitySpan }
  }

  return { config, warnings, droppedKeys, passthrough, sourceAppVersion }
}
