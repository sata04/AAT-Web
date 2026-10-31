import { describe, expect, it } from 'vitest'
import { asFullResolution } from '../../src/analysis/series.ts'
import { plotLegendEntries } from '../../src/graph/plot-legend.ts'
import type { PlotModel, PlotTrace } from '../../src/graph/plot-model.ts'

function trace(key: string, label: string, colour: string, axis: PlotTrace['axis']): PlotTrace {
  const empty = asFullResolution(new Float64Array())
  return { key, label, colour, axis, time: empty, values: empty }
}

const model: PlotModel = {
  traces: [
    trace('inner', 'Run A (Inner Capsule)', '#0969da', 'y'),
    trace('std', 'Inner Capsule: Standard Deviation', '#218bff', 'y2'),
  ],
  title: 'G-quality Analysis - Run A',
  xLabel: 'Window Size (s)',
  yLabel: 'Mean Gravity Level (G)',
  y2Label: 'Standard Deviation (G)',
  xRange: null,
  yRange: null,
  bands: [
    { from: 0, to: 1, colour: '#0969da', label: 'Inner Capsule Range' },
    { from: 0, to: 1, colour: '#cf222e', label: '' },
  ],
  emptyMessage: null,
}

describe('HTML plot legend', () => {
  it('maps trace labels and colours on either axis and includes labelled bands in model order', () => {
    expect(plotLegendEntries(model)).toEqual([
      { key: 'trace:inner', label: 'Run A (Inner Capsule)', colour: '#0969da', kind: 'trace' },
      { key: 'trace:std', label: 'Inner Capsule: Standard Deviation', colour: '#218bff', kind: 'trace' },
      { key: 'band:0', label: 'Inner Capsule Range', colour: '#0969da', kind: 'band' },
    ])
  })

  it('follows series visibility without removing independently drawn bands', () => {
    expect(plotLegendEntries(model, new Set(['inner'])).map((entry) => entry.key)).toEqual([
      'trace:std',
      'band:0',
    ])
    expect(plotLegendEntries(model, new Set()).map((entry) => entry.key)).toContain('trace:inner')
  })

  it('has no entries for an empty graph', () => {
    expect(plotLegendEntries({ ...model, traces: [], bands: [] })).toEqual([])
  })
})
