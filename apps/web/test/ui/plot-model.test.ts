import { describe, expect, it } from 'vitest'
import { defaultViewportFor, graphBoundsFor, type PlotModel } from '../../src/graph/plot-model.ts'

const model: PlotModel = {
  traces: [],
  title: 'G-quality',
  xLabel: 'Window Size (s)',
  yLabel: 'Mean Gravity Level (G)',
  y2Label: null,
  xRange: null,
  yRange: null,
  bands: [],
  emptyMessage: null,
}

describe('default viewport', () => {
  it.each([
    { value: 2, expected: { min: 1.5, max: 2.5 } },
    { value: 0, expected: { min: -0.5, max: 0.5 } },
    { value: -20, expected: { min: -22, max: -18 } },
    { value: 20, expected: { min: 18, max: 22 } },
  ])('centres a singleton at $value seconds with useful padding', ({ value, expected }) => {
    const dataRange = { min: value, max: value }
    const viewport = defaultViewportFor(model, dataRange, 1.45)
    expect(viewport).toEqual(expected)
    expect(graphBoundsFor(dataRange, viewport)).toEqual(expected)
  })

  it('keeps an explicitly fixed viewport', () => {
    expect(defaultViewportFor({ ...model, xRange: [0, 1.45] }, { min: 2, max: 2 }, 1.45)).toEqual({
      min: 0,
      max: 1.45,
    })
  })

  it('still fits a nondegenerate extent and uses the nominal duration for empty data', () => {
    expect(defaultViewportFor(model, { min: 2, max: 3 }, 1.45)).toEqual({ min: 2, max: 3 })
    expect(defaultViewportFor(model, null, 1.45)).toEqual({ min: 0, max: 1.45 })
  })
})
