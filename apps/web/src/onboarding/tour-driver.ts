/**
 * The narrow lane the tour drives the analyzer through.
 *
 * The stage is deliberately not handed the screen's whole action surface: the
 * tour needs a handful of verbs (open this file, set this selection, change
 * this mode) and a way to read what the analyzer currently shows. Keeping the
 * surface narrow is what makes the tour a driver of the real pipeline rather
 * than a parallel implementation of it — every verb here is the same code a
 * pointer event would reach.
 */

import type { Dataset } from '../app/dataset.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { ViewEvent, ViewMode } from '../graph/view-mode.ts'

/** What the analyzer looks like right now, as the tour's waits see it. */
export interface TourSnapshot {
  readonly datasets: readonly Dataset[]
  readonly mode: ViewMode
  /** `statuses.analysis.kind === 'ready'` — the pipeline's done signal. */
  readonly analysisReady: boolean
  /** The plotted data's x extent — where a selection can meaningfully land. */
  readonly dataRange: { min: number; max: number } | null
  /** Data→pixel mapping for the plot area, so the demo cursor can track data. */
  readonly geometry: ChartGeometry | null
  /** uPlot's `.u-over`: the plot area's own element — its rect is the graph. */
  readonly gestureLayer: HTMLElement | null
}

export interface TourDriver {
  /** Fresh read of the analyzer's state — the scene clock polls this. */
  snapshot(): TourSnapshot
  /** The real `openFiles` path: decode, detect, analyse, install. */
  openFiles(files: File[]): Promise<void>
  /** Close whichever open datasets carry these filenames (e.g. the demo pair). */
  closeDatasets(filenames: readonly string[]): void
  /** A real view-mode event — the same ones the toolbar buttons raise. */
  applyModeEvent(event: ViewEvent): void
  /** Put the named dataset (by *filename*) on screen, resetting its framing. */
  activateDataset(filename: string): void
  setSelection(range: SelectionRange | null): void
  /** `null` is the real reset — the same call 「全体表示」 makes. */
  setViewport(viewport: ChartViewport | null): void
  /** Back to the empty-workspace view: normal mode, nothing selected. */
  resetView(): void
  /** The one CSV picker on the page is the toolbar's — click it for real. */
  openFilePicker(): void
}
