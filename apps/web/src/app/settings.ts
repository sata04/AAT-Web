/**
 * Configuration persistence.
 *
 * The desktop keeps `config.json` in an OS-specific directory. The browser
 * equivalent is `localStorage`: small, synchronous, and available before the
 * first paint, which matters because the theme has to be right on the first
 * frame rather than flashing white and then correcting itself.
 *
 * Validation is `AnalysisConfigSchema` from `@aat/shared`, so a hand-edited or
 * out-of-date stored value falls back field by field to the frozen defaults
 * instead of failing the whole document — the philosophy `core/config.py`
 * documents as "never throw on bad input".
 */

import {
  type AnalysisConfig,
  AnalysisConfigSchema,
  DEFAULT_ANALYSIS_CONFIG,
  migrateDesktopConfig,
} from '@aat/shared'

const STORAGE_KEY = 'aat.analysis-config.v1'

/** Load the stored configuration, or the frozen defaults. */
export function loadConfig(): AnalysisConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_ANALYSIS_CONFIG }
    const parsed: unknown = JSON.parse(raw)
    // Reuse the desktop migration path: it validates field by field and reports
    // what it had to reset, which is exactly the behaviour wanted for a stored
    // document written by an older build of this app.
    return migrateDesktopConfig(parsed).config
  } catch {
    return { ...DEFAULT_ANALYSIS_CONFIG }
  }
}

/**
 * Persist the configuration.
 *
 * Returns whether the write landed. Storage can be full or denied (private
 * windows, strict cookie policies) and losing a preference is not a reason to
 * interrupt an analysis — but the settings dialog does say so.
 */
export function saveConfig(config: AnalysisConfig): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
    return true
  } catch {
    return false
  }
}

/** Validate an arbitrary edit against the schema, returning field errors. */
export function validateConfig(
  candidate: Record<string, unknown>,
): { ok: true; config: AnalysisConfig } | { ok: false; errors: Record<string, string> } {
  const parsed = AnalysisConfigSchema.safeParse(candidate)
  if (parsed.success) {
    const config = parsed.data
    const errors: Record<string, string> = {}
    // Cross-field rules the schema cannot express, mirroring
    // `core/config.py::validate_config`'s combination checks.
    if (config.ylim_min >= config.ylim_max) {
      errors.ylim_min = 'Y軸の下限は上限より小さくしてください。'
    }
    if (config.g_quality_start > config.g_quality_end) {
      errors.g_quality_start = 'G-quality開始値は終了値以下にしてください。'
    }
    if (config.g_quality_step > config.g_quality_end - config.g_quality_start) {
      errors.g_quality_step = 'G-qualityの刻み幅が走査範囲より大きくなっています。'
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors }
    return { ok: true, config }
  }

  const errors: Record<string, string> = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.map(String).join('.')
    errors[key] = issue.message
  }
  return { ok: false, errors }
}

/** Read a desktop `config.json` the user picked, via the shared migration. */
export function importDesktopConfig(text: string): ReturnType<typeof migrateDesktopConfig> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return migrateDesktopConfig(json)
}
