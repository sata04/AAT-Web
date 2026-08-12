/**
 * Settings validation and desktop import.
 *
 * The frozen defaults are asserted here because they are not preferences: a file
 * analysed with a different `gravity_constant` or `window_size` produces
 * different published numbers. A change to any of them should have to be a
 * deliberate edit to this test as well.
 */

import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { describe, expect, it } from 'vitest'
import { importDesktopConfig, validateConfig } from '../../src/app/settings.ts'

describe('frozen defaults', () => {
  it('matches config/config.default.json of the desktop release', () => {
    expect(DEFAULT_ANALYSIS_CONFIG).toMatchObject({
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
})

describe('validateConfig', () => {
  it('accepts the defaults', () => {
    const result = validateConfig({ ...DEFAULT_ANALYSIS_CONFIG })
    expect(result.ok).toBe(true)
  })

  it('accepts numeric strings, as the desktop config layer does', () => {
    const result = validateConfig({ ...DEFAULT_ANALYSIS_CONFIG, window_size: '0.25' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.window_size).toBe(0.25)
  })

  it('rejects a window size of zero rather than rounding it to one sample', () => {
    // A zero-width window reports a flawless standard deviation of 0 for
    // meaningless input; the engine raises on it, so the dialog must not accept it.
    const result = validateConfig({ ...DEFAULT_ANALYSIS_CONFIG, window_size: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(Object.keys(result.errors)).toContain('window_size')
  })

  it('catches the cross-field rules a per-field schema cannot express', () => {
    const inverted = validateConfig({ ...DEFAULT_ANALYSIS_CONFIG, ylim_min: 1, ylim_max: -1 })
    expect(inverted.ok).toBe(false)
    if (!inverted.ok) expect(inverted.errors.ylim_min).toBeDefined()

    const backwards = validateConfig({
      ...DEFAULT_ANALYSIS_CONFIG,
      g_quality_start: 1.0,
      g_quality_end: 0.1,
    })
    expect(backwards.ok).toBe(false)

    const tooCoarse = validateConfig({ ...DEFAULT_ANALYSIS_CONFIG, g_quality_step: 5 })
    expect(tooCoarse.ok).toBe(false)
    if (!tooCoarse.ok) expect(tooCoarse.errors.g_quality_step).toBeDefined()
  })
})

describe('desktop import', () => {
  it('migrates a desktop config.json and reports what it dropped', () => {
    const result = importDesktopConfig(
      JSON.stringify({
        app_version: '11.1.0',
        sampling_rate: 2000,
        gravity_constant: 9.80665,
        time_column: 'データセット1:時間(s)',
        window_size: 0.2,
      }),
    )
    expect(result.config.sampling_rate).toBe(2000)
    expect(result.config.gravity_constant).toBe(9.80665)
    expect(result.config.window_size).toBe(0.2)
    expect(result.sourceAppVersion).toBe('11.1.0')
    // Column mappings describe one CSV, so they are not part of the config.
    expect(result.droppedKeys).toContain('time_column')
  })

  it('falls back field by field instead of failing the whole document', () => {
    const result = importDesktopConfig(JSON.stringify({ sampling_rate: -5, gravity_constant: 9.80665 }))
    expect(result.config.sampling_rate).toBe(DEFAULT_ANALYSIS_CONFIG.sampling_rate)
    expect(result.config.gravity_constant).toBe(9.80665)
    expect(result.warnings.some((warning) => warning.key === 'sampling_rate')).toBe(true)
  })

  it('survives a file that is not JSON at all', () => {
    const result = importDesktopConfig('this is not json')
    expect(result.config).toEqual(DEFAULT_ANALYSIS_CONFIG)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
