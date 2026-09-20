/**
 * The two export verbs, shared by the analyzer and the replay panel.
 *
 * `runWorkbookExport` covers only the worker round-trip and its reporting;
 * building the `WorkbookInput` stays with the caller, because the two call
 * sites disagree deliberately about whether a build failure is reportable —
 * the analyzer lets it propagate, the replay panel catches it into the
 * notice stack.
 *
 * The workbook's unified time axis resamples at the rate the numbers were
 * produced under — the dataset's own config — not the live settings a reader
 * or a settings edit may have moved on to.
 */

import type { Dataset } from '../app/dataset.ts'
import type { RangeStatisticsResult } from '../app/range-statistics.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import type { WorkbookInput } from '../export/workbook.ts'
import type { GraphPalette } from '../graph/theme.ts'
import { type ExportClient, ExportTooLargeForWorksheet, saveBlob } from './client.ts'
import { type RangeStatisticsForExport, workbookInputFor } from './input.ts'
import { canvasToPng, PNG_PARITY_NOTICE } from './png.ts'

/** The range block `workbookInputFor` takes, or null when nothing is selected. */
export function rangeInputFor(rangeResult: RangeStatisticsResult | null): RangeStatisticsForExport | null {
  if (rangeResult === null) return null
  return { range: rangeResult.range, inner: rangeResult.inner, drag: rangeResult.drag }
}

/**
 * Run a prepared workbook input through the export worker and report the
 * result. Never truncates: a workbook too big for its sheet is reported with
 * a pointer at the format that has no row limit.
 */
export async function runWorkbookExport(deps: {
  input: WorkbookInput
  name: string
  format: 'xlsx' | 'csv'
  getExportClient: () => ExportClient
  notify: (tone: NoticeItem['tone'], text: string) => void
}): Promise<void> {
  try {
    const result = await deps.getExportClient().run(deps.format, deps.input)
    saveBlob(result.blob, `${deps.name}.${deps.format}`)
    deps.notify('info', `${deps.name} を書き出しました。`)
  } catch (error) {
    if (error instanceof ExportTooLargeForWorksheet) {
      deps.notify('warning', `${error.message}\n「CSVで書き出す」を選ぶと、行数制限なしで保存できます。`)
      return
    }
    deps.notify('error', error instanceof Error ? error.message : String(error))
  }
}

/** The analyzer's export: build the input for the active dataset, then run it. */
export async function exportWorkbookFor(
  deps: {
    dataset: Dataset | null
    rangeResult: RangeStatisticsResult | null
    getExportClient: () => ExportClient
    notify: (tone: NoticeItem['tone'], text: string) => void
  },
  format: 'xlsx' | 'csv',
): Promise<void> {
  const { dataset } = deps
  if (dataset === null) return
  const input = workbookInputFor(dataset, dataset.config.sampling_rate, rangeInputFor(deps.rangeResult))
  await runWorkbookExport({
    input,
    name: dataset.name,
    format,
    getExportClient: deps.getExportClient,
    notify: deps.notify,
  })
}

export async function exportPngFor(deps: {
  canvas: HTMLCanvasElement | null
  dataset: Dataset | null
  palette: GraphPalette
  notify: (tone: NoticeItem['tone'], text: string) => void
}): Promise<void> {
  if (deps.canvas === null) {
    deps.notify('warning', 'グラフが表示されていないため、PNGを保存できません。')
    return
  }
  try {
    const blob = await canvasToPng(deps.canvas, { scale: 2, background: deps.palette.background })
    saveBlob(blob, `${deps.dataset?.name ?? 'graph'}_gl.png`)
    deps.notify('info', PNG_PARITY_NOTICE)
  } catch (error) {
    deps.notify('error', error instanceof Error ? error.message : String(error))
  }
}
