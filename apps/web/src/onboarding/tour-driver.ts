/**
 * The narrow lane the tour drives the analyzer through.
 *
 * The stage is deliberately not handed the screen's whole action surface: the
 * tour needs a handful of verbs (open this file, set this selection, change
 * this mode) and a way to read what the analyzer currently shows. Keeping the
 * surface narrow is what makes the tour a driver of the real pipeline rather
 * than a parallel implementation of it — every verb here is the same code a
 * pointer event would reach.
 *
 * Two ownership rules keep the tour honest on a workspace that is not empty:
 *
 *   - datasets the tour installs are tracked as they land (`openDemo`), so
 *     cleanup removes exactly them — never a researcher's own file that happens
 *     to share the demo's name;
 *   - the view found when the stage opened is capturable and restorable
 *     (`restoreBaseline`), so skipping a replayed tour hands back the mode,
 *     active dataset, selection and zoom the researcher left, not a reset.
 */

import type { Dataset } from '../app/dataset.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { ViewEvent, ViewMode } from '../graph/view-mode.ts'
import type { DemoDataset } from './demo-data.ts'

/** The mutable view state the tour captures at open and restores on exit. */
export interface TourView {
  readonly mode: ViewMode
  readonly activeName: string | null
  readonly selection: SelectionRange | null
  readonly viewport: ChartViewport | null
}

/** What the analyzer looks like right now, as the tour's waits see it. */
export interface TourSnapshot extends TourView {
  readonly datasets: readonly Dataset[]
  /** `statuses.analysis.kind === 'ready'` — the pipeline's done signal. */
  readonly analysisReady: boolean
  /** The plotted data's x extent — where a selection can meaningfully land. */
  readonly dataRange: { min: number; max: number } | null
  /** Data→pixel mapping for the plot area, so the demo cursor can track data. */
  readonly geometry: ChartGeometry | null
  /** uPlot's `.u-over`: the plot area's own element — its rect is the graph. */
  readonly gestureLayer: HTMLElement | null
}

export function tourViewOf(snapshot: TourSnapshot): TourView {
  const { mode, activeName, selection, viewport } = snapshot
  return { mode, activeName, selection, viewport }
}

export interface TourDriver {
  /** Fresh read of the analyzer's state — the scene clock polls this. */
  snapshot(): TourSnapshot
  /** The real `openFiles` path: decode, detect, analyse, install. */
  openFiles(files: File[]): Promise<void>
  /**
   * Open the generated demo CSV, under a fallback name when a dataset the tour
   * does not own already claims the usual one, so a researcher's own
   * `sample-a.csv` is never replaced by the demo. Resolves with the filename
   * actually used — once the install lands — and records the dataset as
   * tour-owned for cleanup. If the run was discarded while this open was in
   * flight, the dataset is closed again as soon as it installs.
   */
  openDemo(which: DemoDataset): Promise<string>
  /**
   * Close the demo datasets this run installed, keeping the roles listed.
   * A researcher's own files are never matched: ownership was recorded at
   * install time, not inferred from the filename.
   */
  closeTourDatasets(except?: readonly DemoDataset[]): void
  /**
   * Invalidate demo opens still in flight: their installs close on landing
   * instead of appearing on a workspace the tour has already left.
   */
  discardPending(): void
  /** Put the tour-owned `which` dataset on screen, resetting its framing. */
  activateDemo(which: DemoDataset): void
  /** A real view-mode event — the same ones the toolbar buttons raise. */
  applyModeEvent(event: ViewEvent): void
  setSelection(range: SelectionRange | null): void
  /** `null` is the real reset — the same call 「全体表示」 makes. */
  setViewport(viewport: ChartViewport | null): void
  /**
   * Restore the view the stage found when it opened — mode, active dataset,
   * selection, zoom — falling back to the first remaining dataset when the
   * baseline's active one no longer exists.
   */
  restoreBaseline(): void
  /** The one CSV picker on the page is the toolbar's — click it for real. */
  openFilePicker(): void
}
