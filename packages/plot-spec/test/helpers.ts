/** Shared test fixtures for building valid/invalid poster plot spec inputs. */

import { encodeSeries } from '../src/wire.ts'

/** Build a wire-format series pair (time + values) from plain arrays, `null` meaning a gap. */
export function buildSeriesData(time: readonly number[], values: readonly (number | null)[]) {
  return {
    time: encodeSeries(Float64Array.from(time)),
    values: encodeSeries(values),
  }
}

const DEFAULT_TIME = [0, 0.01, 0.02, 0.03, 0.04]
const DEFAULT_INNER_VALUES = [0.001, 0.002, null, -0.001, 0.0005]
const DEFAULT_DRAG_VALUES = [0.003, 0.0025, 0.0018, null, 0.0012]

/** A minimal, fully valid poster plot spec input (as plain JSON, pre-parse). Override fields as needed. */
export function validSpecInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    analysisRevisionId: 'rev-260811a-1',
    runCode: '260811a',
    posterKind: 'auto',
    posterPresetVersion: 'aat-poster-v1',
    xMin: 0,
    xMax: 1.45,
    series: 'both',
    title: 'The Gravity Level 260811a',
    showLegend: true,
    figureWidth: 10.6,
    figureHeight: 3.4,
    dpi: 300,
    data: {
      inner: buildSeriesData(DEFAULT_TIME, DEFAULT_INNER_VALUES),
      drag: buildSeriesData(DEFAULT_TIME, DEFAULT_DRAG_VALUES),
    },
    ...overrides,
  }
}
