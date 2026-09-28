import type { PlotModel } from './plot-model.ts'

export interface PlotLegendEntry {
  key: string
  label: string
  colour: string
  kind: 'trace' | 'band'
}

/** The current pixels and their identification travel together to PNG export. */
export interface PlotCanvas {
  canvas: HTMLCanvasElement
  title: string
  legend: readonly { color: string; label: string }[]
}

export function plotCanvasFor(
  canvas: HTMLCanvasElement,
  model: PlotModel,
  hiddenTraceKeys: ReadonlySet<string>,
): PlotCanvas {
  return {
    canvas,
    title: model.title,
    legend: plotLegendEntries(model, hiddenTraceKeys).map(({ colour, label }) => ({ color: colour, label })),
  }
}

/** Shared by all modes, including the right-axis traces and labelled kept ranges. */
export function plotLegendEntries(
  model: PlotModel,
  hiddenTraceKeys: ReadonlySet<string> = new Set(),
): PlotLegendEntry[] {
  return [
    ...model.traces
      .filter((trace) => !hiddenTraceKeys.has(trace.key))
      .map(
        (trace): PlotLegendEntry => ({
          key: `trace:${trace.key}`,
          label: trace.label,
          colour: trace.colour,
          kind: 'trace',
        }),
      ),
    ...model.bands.flatMap((band, index): PlotLegendEntry[] =>
      band.label.trim() === ''
        ? []
        : [{ key: `band:${index}`, label: band.label, colour: band.colour, kind: 'band' }],
    ),
  ]
}
