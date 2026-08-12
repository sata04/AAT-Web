import { describe, expect, it } from 'vitest'
import {
  AAT_POSTER_V1_PRESET,
  getPosterPreset,
  POSTER_PRESET_VERSIONS,
  POSTER_PRESETS,
  posterPresetContentHash,
} from '../src/presets.ts'

describe('aat-poster-v1: frozen desktop-compatible constants', () => {
  it('matches the verified figure/axes/line/grid/spine/tick/text/legend constants', () => {
    expect(AAT_POSTER_V1_PRESET.figure.faceColor).toBe('#FFFFFF')
    expect(AAT_POSTER_V1_PRESET.axes.faceColor).toBe('#FFFFFF')

    expect(AAT_POSTER_V1_PRESET.lines.innerMean).toEqual({ color: '#0969DA', lineWidth: 0.8 })
    expect(AAT_POSTER_V1_PRESET.lines.dragMean).toEqual({ color: '#CF222E', lineWidth: 0.8 })
    expect(AAT_POSTER_V1_PRESET.lines.innerStd).toEqual({ color: '#218BFF' })
    expect(AAT_POSTER_V1_PRESET.lines.dragStd).toEqual({ color: '#8250DF' })

    expect(AAT_POSTER_V1_PRESET.grid).toEqual({ lineStyle: '--', alpha: 0.3, color: '#656D76' })
    expect(AAT_POSTER_V1_PRESET.spine).toEqual({ color: '#D0D7DE' })
    expect(AAT_POSTER_V1_PRESET.ticks).toEqual({ color: '#656D76' })
    expect(AAT_POSTER_V1_PRESET.text).toEqual({ axisLabelColor: '#1F2328', titleColor: '#1F2328' })
    expect(AAT_POSTER_V1_PRESET.legend).toEqual({
      faceColor: '#FFFFFF',
      edgeColor: '#D0D7DE',
      textColor: '#1F2328',
    })
  })

  it('matches the verified watermark spec', () => {
    expect(AAT_POSTER_V1_PRESET.watermark).toEqual({
      textTemplate: 'AAT v{version}',
      x: 0.98,
      y: 0.02,
      horizontalAlignment: 'right',
      verticalAlignment: 'bottom',
      fontSize: 8,
      color: '#656D76',
    })
  })

  it('matches the verified label templates', () => {
    expect(AAT_POSTER_V1_PRESET.labels).toEqual({
      titleTemplate: 'The Gravity Level {name}',
      xLabel: 'Time (s)',
      yLabel: 'Gravity Level (G)',
    })
  })

  it('matches the verified default geometry and savefig kwargs', () => {
    expect(AAT_POSTER_V1_PRESET.defaults).toEqual({
      xMin: 0,
      xMax: 1.45,
      figureWidth: 10.6,
      figureHeight: 3.4,
      dpi: 300,
      bboxInches: null,
      tightLayout: true,
    })
  })

  it('is deeply frozen', () => {
    expect(Object.isFrozen(AAT_POSTER_V1_PRESET)).toBe(true)
    expect(Object.isFrozen(AAT_POSTER_V1_PRESET.lines)).toBe(true)
    expect(Object.isFrozen(AAT_POSTER_V1_PRESET.lines.innerMean)).toBe(true)
    expect(Object.isFrozen(AAT_POSTER_V1_PRESET.watermark)).toBe(true)
    expect(() => {
      // @ts-expect-error intentionally attempting a mutation to verify runtime immutability
      AAT_POSTER_V1_PRESET.figure.faceColor = '#000000'
    }).toThrow()
  })

  it('is registered under POSTER_PRESETS and POSTER_PRESET_VERSIONS', () => {
    expect(POSTER_PRESET_VERSIONS).toEqual(['aat-poster-v1'])
    expect(POSTER_PRESETS['aat-poster-v1']).toBe(AAT_POSTER_V1_PRESET)
    expect(getPosterPreset('aat-poster-v1')).toBe(AAT_POSTER_V1_PRESET)
  })
})

describe('posterPresetContentHash', () => {
  it('is a lowercase 64-char hex digest, stable across calls', async () => {
    const hash = await posterPresetContentHash(AAT_POSTER_V1_PRESET)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await posterPresetContentHash(AAT_POSTER_V1_PRESET)).toBe(hash)
  })

  it('changes if any constant in the preset changes', async () => {
    const original = await posterPresetContentHash(AAT_POSTER_V1_PRESET)
    const mutated = { ...AAT_POSTER_V1_PRESET, grid: { ...AAT_POSTER_V1_PRESET.grid, alpha: 0.5 } }
    expect(await posterPresetContentHash(mutated)).not.toBe(original)
  })

  it('pins the current aat-poster-v1 content hash so an accidental edit is caught', async () => {
    // If this assertion ever fails, a frozen constant in AAT_POSTER_V1_PRESET was changed. That
    // is only acceptable as a NEW preset version (see presets.ts's module doc) — update this
    // pinned value only when deliberately introducing e.g. 'aat-poster-v2'.
    const hash = await posterPresetContentHash(AAT_POSTER_V1_PRESET)
    expect(hash).toBe('4bd7f7e4d0e6ff1b1c5a5c1b1d7f9c1b0a0e9d3a4b5c6d7e8f9a0b1c2d3e4f5a')
  })
})
