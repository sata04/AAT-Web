/**
 * The analyzer's lazily-built worker/export clients, and the comparison
 * guard. Each helper takes what it needs as arguments so `AnalyzerScreen`
 * stays wiring.
 */

import type { AnalysisConfig } from '@aat/shared'
import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from 'react'
import { AnalysisClient } from '../analysis/client.ts'
import type { Dataset } from '../app/dataset.ts'
import type { RangeStatisticsResult } from '../app/range-statistics.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import type { CloudStatuses } from '../cloud/status.ts'
import { applyViewEvent } from '../components/hooks.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import { ExportClient } from '../exporting/client.ts'
import { exportPngFor, exportWorkbookFor } from '../exporting/export-actions.ts'
import type { ChartGeometry } from '../graph/geometry.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { GraphPalette } from '../graph/theme.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { ViewMode } from '../graph/view-mode.ts'
import type { PosterContext } from '../poster/requests.ts'
import type { AnalyzerViewProps } from './AnalyzerView.tsx'
import { retryPosterFor, retrySyncFor } from './analyzer-cloud.ts'
import type { AnalyzerLoop } from './analyzer-loop.ts'

function ensure<T>(ref: { current: T | null }, make: () => T): T {
  ref.current ??= make()
  return ref.current
}

function disposeClients(
  analysisClient: { current: AnalysisClient | null },
  exportClient: { current: ExportClient | null },
): void {
  analysisClient.current?.dispose()
  exportClient.current?.dispose()
}

/**
 * The worker and export clients.
 *
 * Lazily constructed so that merely loading the page does not start a worker,
 * and stable so the callbacks that use them do not change identity per
 * render.
 */
export function useAnalysisClients(): {
  analysisClient: { current: AnalysisClient | null }
  getAnalysisClient: () => AnalysisClient
  getExportClient: () => ExportClient
} {
  const analysisClient = useRef<AnalysisClient | null>(null)
  const exportClient = useRef<ExportClient | null>(null)
  const getAnalysisClient = useCallback(() => ensure(analysisClient, () => new AnalysisClient()), [])
  const getExportClient = useCallback(() => ensure(exportClient, () => new ExportClient()), [])
  useEffect(() => () => disposeClients(analysisClient, exportClient), [])
  return { analysisClient, getAnalysisClient, getExportClient }
}

export function startComparisonFor(
  datasetCount: number,
  notify: (tone: NoticeItem['tone'], text: string) => void,
  applyEvent: (event: 'ENTER_COMPARING') => void,
): void {
  if (datasetCount < 2) {
    notify('warning', '比較するには少なくとも2つのファイルが必要です。')
    return
  }
  applyEvent('ENTER_COMPARING')
}

/**
 * The screen's contribution to `analyzerActions`: the working state, the
 * state setters, and the three lanes (`loop`, the cloud callbacks, the
 * clients) already built.
 */
export interface AnalyzerActionsInput {
  loop: AnalyzerLoop
  datasets: readonly Dataset[]
  active: Dataset | null
  mode: ViewMode
  rangeResult: RangeStatisticsResult | null
  canvas: HTMLCanvasElement | null
  palette: GraphPalette
  cloudSubject: string | null
  statuses: CloudStatuses
  syncedPoster: PosterContext | null
  notify: (tone: NoticeItem['tone'], text: string) => void
  dismissNotice: (id: number) => void
  getExportClient: () => ExportClient
  syncToCloud: (dataset: Dataset, analysedWith?: AnalysisConfig) => Promise<void>
  startAutoPoster: (context: PosterContext, posterId: string | null) => Promise<void>
  setMode: Dispatch<SetStateAction<ViewMode>>
  setSelection: Dispatch<SetStateAction<SelectionRange | null>>
  setViewport: Dispatch<SetStateAction<ChartViewport | null>>
  setGeometry: Dispatch<SetStateAction<ChartGeometry | null>>
  setCanvas: Dispatch<SetStateAction<HTMLCanvasElement | null>>
  setGestureLayer: Dispatch<SetStateAction<HTMLElement | null>>
  setActiveName: Dispatch<SetStateAction<string | null>>
  setConfig: Dispatch<SetStateAction<AnalysisConfig>>
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setCustomPosters: Dispatch<SetStateAction<PosterFigure[]>>
  setStatuses: Dispatch<SetStateAction<CloudStatuses>>
}

/**
 * Every handler `AnalyzerView` asks for. The stable setters forward as-is;
 * the rest are thin arrows that close over the screen's current state.
 */
export function analyzerActions(input: AnalyzerActionsInput): AnalyzerViewProps['actions'] {
  const { loop } = input
  const applyEvent = (event: Parameters<typeof applyViewEvent>[1]) =>
    applyViewEvent(input.mode, event, {
      setMode: input.setMode,
      setSelection: input.setSelection,
      setViewport: input.setViewport,
    })
  return {
    openFiles: loop.openFiles,
    applyModeEvent: applyEvent,
    startComparison: () => startComparisonFor(input.datasets.length, input.notify, applyEvent),
    setConfig: input.setConfig,
    applyConfig: loop.applyConfig,
    cancelAnalysis: loop.cancelAnalysis,
    setViewport: input.setViewport,
    setGeometry: input.setGeometry,
    setCanvas: input.setCanvas,
    setGestureLayer: input.setGestureLayer,
    setSelection: input.setSelection,
    setActiveName: input.setActiveName,
    closeDataset: loop.closeDataset,
    exportData: (format) =>
      exportWorkbookFor(
        {
          dataset: input.active,
          rangeResult: input.rangeResult,
          getExportClient: input.getExportClient,
          notify: input.notify,
        },
        format,
      ),
    exportPng: () =>
      exportPngFor({
        canvas: input.canvas,
        dataset: input.active,
        palette: input.palette,
        notify: input.notify,
      }),
    dismissNotice: input.dismissNotice,
    retrySync: () =>
      retrySyncFor({
        datasets: input.datasets,
        cloudSubject: input.cloudSubject,
        setStatuses: input.setStatuses,
        syncToCloud: input.syncToCloud,
      }),
    retryPoster: () => retryPosterFor(input.statuses, input.syncedPoster, input.startAutoPoster),
    addCustomPoster: (poster) => input.setCustomPosters((current) => [poster, ...current]),
    notify: input.notify,
    setPendingColumns: loop.setPendingColumns,
    confirmPendingColumns: loop.confirmPendingColumns,
    cancelPendingColumns: loop.cancelPendingColumns,
    runAnalysis: loop.runAnalysis,
    setSettingsOpen: input.setSettingsOpen,
  }
}
