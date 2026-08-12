/**
 * Theme resolution and the graph palette.
 *
 * The `GRAPH_*` colours are marked "Frozen (export): do not modify" in
 * `gui/styles.py` because they are baked into published figures. Pinning them
 * here means a palette tweak that would silently change every future figure
 * fails a test instead.
 */

import { describe, expect, it } from 'vitest'
import {
  comparisonColour,
  exportPalette,
  graphPalette,
  resolveTheme,
  themeSettingFrom,
} from '../../src/graph/theme.ts'

describe('resolveTheme', () => {
  it('honours an explicit choice regardless of the platform', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('defers to the platform for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('never returns "system" — the deferral resolves at paint time', () => {
    for (const setting of ['system', 'light', 'dark'] as const) {
      for (const prefersDark of [true, false]) {
        expect(['light', 'dark']).toContain(resolveTheme(setting, prefersDark))
      }
    }
  })
})

describe('themeSettingFrom', () => {
  it('narrows the three valid spellings', () => {
    expect(themeSettingFrom('light')).toBe('light')
    expect(themeSettingFrom('dark')).toBe('dark')
    expect(themeSettingFrom('system')).toBe('system')
  })

  it('falls back to the platform rather than to an arbitrary theme', () => {
    expect(themeSettingFrom('')).toBe('system')
    expect(themeSettingFrom('solarized')).toBe('system')
  })
})

describe('graph palette', () => {
  it('carries the frozen export colours from gui/styles.py', () => {
    const light = graphPalette('light')
    expect(light.innerMean).toBe('#0969DA')
    expect(light.dragMean).toBe('#CF222E')
    expect(light.innerStd).toBe('#218BFF')
    expect(light.dragStd).toBe('#8250DF')
    expect(light.span).toBe('#0969DA')
    expect(light.highlight).toBe('#1A7F37')

    const dark = graphPalette('dark')
    expect(dark.innerMean).toBe('#58A6FF')
    expect(dark.dragMean).toBe('#F85149')
    expect(dark.innerStd).toBe('#79C0FF')
    expect(dark.dragStd).toBe('#D2A8FF')
  })

  it('always exports on the light palette, whatever is on screen', () => {
    // A dark-theme figure pasted into a paper is a mistake nobody notices until
    // it is printed; PlotController._get_export_palette fixes white.
    expect(exportPalette()).toEqual(graphPalette('light'))
    expect(exportPalette().background).toBe('#FFFFFF')
  })

  it('distinguishes the two sensors in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const palette = graphPalette(theme)
      expect(palette.innerMean).not.toBe(palette.dragMean)
      expect(palette.innerStd).not.toBe(palette.dragStd)
    }
  })

  it('wraps the comparison ramp instead of running out of colours', () => {
    const palette = graphPalette('dark')
    const count = palette.comparison.length
    expect(comparisonColour(palette, 0)).toBe(palette.comparison[0])
    expect(comparisonColour(palette, count)).toBe(palette.comparison[0])
    expect(comparisonColour(palette, count + 3)).toBe(palette.comparison[3])
  })

  it('keeps adjacent comparison colours distinct', () => {
    for (const theme of ['light', 'dark'] as const) {
      const colours = graphPalette(theme).comparison
      expect(new Set(colours).size).toBe(colours.length)
    }
  })
})
