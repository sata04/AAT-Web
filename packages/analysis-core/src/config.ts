/**
 * The configuration the numerical pipeline reads.
 *
 * Only the keys that change a number are here. The desktop application keeps
 * presentation settings (axis limits, theme, export DPI) in the same JSON
 * object; those belong to the layers above this package, and a wider config
 * object still satisfies this interface structurally.
 *
 * Field names are camelCase, but the persisted format is the desktop app's
 * snake_case JSON — that file is the migration baseline, so
 * `analysisConfigFromRecord` reads it directly.
 */

export interface AnalysisConfig {
  /** Column holding the time axis, in seconds. */
  timeColumn: string
  /** Column holding Inner Capsule acceleration, in m/s^2. */
  accelerationColumnInnerCapsule: string
  /** Column holding Drag Shield acceleration, in m/s^2. */
  accelerationColumnDragShield: string
  useInnerAcceleration: boolean
  useDragAcceleration: boolean
  /** Nominal data rate in Hz; converts window sizes in seconds into samples. */
  samplingRate: number
  /** Reference gravity in m/s^2; acceleration is divided by it to give G. */
  gravityConstant: number
  /** |acceleration| below this (m/s^2) marks the release/sync point. */
  accelerationThreshold: number
  /** Gravity level (G) whose first occurrence ends the analysed segment. */
  endGravityLevel: number
  /** Primary analysis window, in seconds. */
  windowSize: number
  /** G-quality sweep bounds and step, in seconds. */
  gQualityStart: number
  gQualityEnd: number
  gQualityStep: number
  /** Seconds after the start that the end search may not begin before. */
  minSecondsAfterStart: number
  /** Negate Inner Capsule acceleration (the sensor is mounted inverted). */
  invertInnerAcceleration: boolean
}

/**
 * The frozen migration baseline — `config/config.default.json` of AAT 11.1.0.
 *
 * Defaults matter beyond convenience: a file analysed with a different
 * `gravityConstant` or `windowSize` produces different published numbers, so
 * these values are pinned rather than reinvented.
 */
export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  timeColumn: 'データセット1:時間(s)',
  accelerationColumnInnerCapsule: 'データセット1:Z-axis acceleration 1(m/s²)',
  accelerationColumnDragShield: 'データセット1:Z-axis acceleration 2(m/s²)',
  useInnerAcceleration: true,
  useDragAcceleration: true,
  samplingRate: 1000,
  gravityConstant: 9.797578,
  accelerationThreshold: 5.0,
  endGravityLevel: 8.0,
  windowSize: 0.1,
  gQualityStart: 0.1,
  gQualityEnd: 1.0,
  gQualityStep: 0.05,
  minSecondsAfterStart: 0.7,
  invertInnerAcceleration: true,
}

function readString(record: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : fallback
}

function readNumber(record: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = record[key]
  if (typeof value === 'number') return value
  // The desktop config layer accepts numeric strings, so honour them here too.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function readBoolean(record: Readonly<Record<string, unknown>>, key: string, fallback: boolean): boolean {
  const value = record[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase()
    if (normalised === 'true') return true
    if (normalised === 'false') return false
  }
  return fallback
}

/**
 * Read the desktop application's snake_case configuration JSON.
 *
 * Unknown keys are ignored and absent keys fall back to
 * `DEFAULT_ANALYSIS_CONFIG`, so a config file written by an older version still
 * loads with the documented defaults rather than with `undefined`.
 */
export function analysisConfigFromRecord(record: Readonly<Record<string, unknown>>): AnalysisConfig {
  const defaults = DEFAULT_ANALYSIS_CONFIG
  return {
    timeColumn: readString(record, 'time_column', defaults.timeColumn),
    accelerationColumnInnerCapsule: readString(
      record,
      'acceleration_column_inner_capsule',
      defaults.accelerationColumnInnerCapsule,
    ),
    accelerationColumnDragShield: readString(
      record,
      'acceleration_column_drag_shield',
      defaults.accelerationColumnDragShield,
    ),
    useInnerAcceleration: readBoolean(record, 'use_inner_acceleration', defaults.useInnerAcceleration),
    useDragAcceleration: readBoolean(record, 'use_drag_acceleration', defaults.useDragAcceleration),
    samplingRate: readNumber(record, 'sampling_rate', defaults.samplingRate),
    gravityConstant: readNumber(record, 'gravity_constant', defaults.gravityConstant),
    accelerationThreshold: readNumber(record, 'acceleration_threshold', defaults.accelerationThreshold),
    endGravityLevel: readNumber(record, 'end_gravity_level', defaults.endGravityLevel),
    windowSize: readNumber(record, 'window_size', defaults.windowSize),
    gQualityStart: readNumber(record, 'g_quality_start', defaults.gQualityStart),
    gQualityEnd: readNumber(record, 'g_quality_end', defaults.gQualityEnd),
    gQualityStep: readNumber(record, 'g_quality_step', defaults.gQualityStep),
    minSecondsAfterStart: readNumber(record, 'min_seconds_after_start', defaults.minSecondsAfterStart),
    invertInnerAcceleration: readBoolean(
      record,
      'invert_inner_acceleration',
      defaults.invertInnerAcceleration,
    ),
  }
}
