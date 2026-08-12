import { describe, expect, it } from 'vitest'
import {
  AnalysisConfigSchema,
  configHash,
  DEFAULT_ANALYSIS_CONFIG,
  migrateDesktopConfig,
  NUMERIC_RESULT_CONFIG_KEYS,
} from '../src/config.ts'

describe('AnalysisConfigSchema defaults', () => {
  it('matches the frozen desktop config.default.json baseline', () => {
    expect(DEFAULT_ANALYSIS_CONFIG).toEqual({
      sampling_rate: 1000,
      gravity_constant: 9.797578,
      ylim_min: -1.0,
      ylim_max: 1.0,
      acceleration_threshold: 5.0,
      end_gravity_level: 8.0,
      window_size: 0.1,
      g_quality_start: 0.1,
      g_quality_end: 1.0,
      g_quality_step: 0.05,
      min_seconds_after_start: 0.7,
      auto_calculate_g_quality: true,
      use_cache: true,
      default_graph_duration: 1.45,
      graph_sensor_mode: 'both',
      theme: 'system',
      export_figure_width: 10.6,
      export_figure_height: 3.4,
      export_dpi: 300,
      export_bbox_inches: null,
      invert_inner_acceleration: true,
    })
  })

  it('rejects an out-of-range value', () => {
    expect(AnalysisConfigSchema.safeParse({ sampling_rate: 0 }).success).toBe(false)
    expect(AnalysisConfigSchema.safeParse({ export_dpi: 5 }).success).toBe(false)
    expect(AnalysisConfigSchema.safeParse({ graph_sensor_mode: 'nonsense' }).success).toBe(false)
  })
})

describe('configHash', () => {
  it('is stable for the same numeric-result-affecting values', async () => {
    const a = { ...DEFAULT_ANALYSIS_CONFIG }
    const b = { ...DEFAULT_ANALYSIS_CONFIG }
    await expect(configHash(a)).resolves.toBe(await configHash(b))
  })

  it('is a lowercase hex SHA-256', async () => {
    const hash = await configHash(DEFAULT_ANALYSIS_CONFIG)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when a numeric-result-affecting key changes', async () => {
    const base = await configHash(DEFAULT_ANALYSIS_CONFIG)
    const changed = await configHash({ ...DEFAULT_ANALYSIS_CONFIG, window_size: 0.2 })
    expect(changed).not.toBe(base)
  })

  it('is insensitive to presentation-only keys', async () => {
    const base = await configHash(DEFAULT_ANALYSIS_CONFIG)
    const presentationChanged = await configHash({
      ...DEFAULT_ANALYSIS_CONFIG,
      theme: 'dark',
      ylim_min: -5,
      ylim_max: 5,
      export_figure_width: 20,
      export_figure_height: 8,
      export_dpi: 600,
      export_bbox_inches: 'tight',
      default_graph_duration: 3.0,
      graph_sensor_mode: 'inner_only',
      use_cache: false,
    })
    expect(presentationChanged).toBe(base)
  })

  it('covers every numeric-result key with a real change (canary for the exclusion list)', async () => {
    for (const key of NUMERIC_RESULT_CONFIG_KEYS) {
      const base = await configHash(DEFAULT_ANALYSIS_CONFIG)
      const currentValue = DEFAULT_ANALYSIS_CONFIG[key]
      const changedValue =
        typeof currentValue === 'boolean' ? !currentValue : (currentValue as number) * 2 + 1
      const changed = await configHash({ ...DEFAULT_ANALYSIS_CONFIG, [key]: changedValue })
      expect(changed, `expected changing "${key}" to change the hash`).not.toBe(base)
    }
  })
})

describe('migrateDesktopConfig', () => {
  it('carries over valid values and reports no warnings', () => {
    const result = migrateDesktopConfig({
      window_size: 0.2,
      sampling_rate: 2000,
      theme: 'dark',
    })
    expect(result.warnings).toEqual([])
    expect(result.config.window_size).toBe(0.2)
    expect(result.config.sampling_rate).toBe(2000)
    expect(result.config.theme).toBe('dark')
    // Untouched keys keep their frozen defaults.
    expect(result.config.gravity_constant).toBe(DEFAULT_ANALYSIS_CONFIG.gravity_constant)
  })

  it('falls back to the default and warns on an invalid value, without failing the whole document', () => {
    const result = migrateDesktopConfig({ sampling_rate: -5, window_size: 0.3 })
    expect(result.config.sampling_rate).toBe(DEFAULT_ANALYSIS_CONFIG.sampling_rate)
    expect(result.config.window_size).toBe(0.3)
    expect(result.warnings.some((w) => w.key === 'sampling_rate')).toBe(true)
  })

  it('coerces a numeric string the way the desktop app does', () => {
    const result = migrateDesktopConfig({ window_size: '0.25' })
    expect(result.config.window_size).toBe(0.25)
    expect(result.warnings).toEqual([])
  })

  it('drops column-mapping keys and app_version, preserving them separately', () => {
    const result = migrateDesktopConfig({
      time_column: 'データセット1:時間(s)',
      acceleration_column_inner_capsule: 'foo',
      use_inner_acceleration: true,
      app_version: '2.3.1',
      some_future_key: 'mystery',
    })
    expect(result.sourceAppVersion).toBe('2.3.1')
    expect(result.droppedKeys.sort()).toEqual(
      [
        'time_column',
        'acceleration_column_inner_capsule',
        'use_inner_acceleration',
        'app_version',
        'some_future_key',
      ].sort(),
    )
    expect(result.passthrough).toEqual({
      time_column: 'データセット1:時間(s)',
      acceleration_column_inner_capsule: 'foo',
      use_inner_acceleration: true,
      some_future_key: 'mystery',
    })
    expect(result.passthrough).not.toHaveProperty('app_version')
  })

  it('is forgiving of malformed input: not an object at all', () => {
    for (const malformed of [null, undefined, 'a string', 42, ['array', 'input']]) {
      const result = migrateDesktopConfig(malformed)
      expect(result.config).toEqual(DEFAULT_ANALYSIS_CONFIG)
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  it('resets ylim_min/ylim_max together when min >= max', () => {
    const result = migrateDesktopConfig({ ylim_min: 5, ylim_max: 1 })
    expect(result.config.ylim_min).toBe(DEFAULT_ANALYSIS_CONFIG.ylim_min)
    expect(result.config.ylim_max).toBe(DEFAULT_ANALYSIS_CONFIG.ylim_max)
    expect(result.warnings.some((w) => w.key.includes('ylim'))).toBe(true)
  })

  it('resets g_quality_start/end together when start > end', () => {
    const result = migrateDesktopConfig({ g_quality_start: 0.9, g_quality_end: 0.2 })
    expect(result.config.g_quality_start).toBe(DEFAULT_ANALYSIS_CONFIG.g_quality_start)
    expect(result.config.g_quality_end).toBe(DEFAULT_ANALYSIS_CONFIG.g_quality_end)
  })

  it('clamps g_quality_step to the scan range when it overshoots', () => {
    const result = migrateDesktopConfig({ g_quality_start: 0.1, g_quality_end: 0.2, g_quality_step: 5 })
    expect(result.config.g_quality_step).toBeCloseTo(0.1, 10)
    expect(result.warnings.some((w) => w.key === 'g_quality_step')).toBe(true)
  })
})
