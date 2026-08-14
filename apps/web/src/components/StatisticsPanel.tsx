/**
 * The results tables — `MainWindow.update_standard_table` and
 * `update_g_quality_table`.
 *
 * Column headings keep the desktop's two-level scheme: a short label that fits,
 * and the full English name (the one that appears in the exported workbook) as
 * the tooltip and the accessible description. Someone reading a spreadsheet
 * someone else exported can match the two without a glossary.
 */

import type { Dataset } from '../app/dataset.ts'
import { formatFixed, formatSeconds } from '../app/format.ts'
import type { ViewMode } from '../graph/view-mode.ts'
import { isGQuality } from '../graph/view-mode.ts'
import { TABLE_SCROLL_PROPS } from './table-scroll.ts'

const STANDARD_HEADERS = [
  { short: 'ファイル名', full: 'File Name', numeric: false },
  {
    short: 'IC: 最小SD開始 (s)',
    full: 'Inner Capsule: Start Time of Min SD Window for Given Window Size (s)',
    numeric: true,
  },
  { short: 'IC: 平均G (G)', full: 'Inner Capsule: Mean G-Level in Min SD Window (G)', numeric: true },
  { short: 'IC: SD (G)', full: 'Inner Capsule: SD in Min SD Window (G)', numeric: true },
  {
    short: 'DS: 最小SD開始 (s)',
    full: 'Drag Shield: Start Time of Min SD Window for Given Window Size (s)',
    numeric: true,
  },
  { short: 'DS: 平均G (G)', full: 'Drag Shield: Mean G-Level in Min SD Window (G)', numeric: true },
  { short: 'DS: SD (G)', full: 'Drag Shield: SD in Min SD Window (G)', numeric: true },
] as const

const G_QUALITY_HEADERS = [
  { short: 'データセット', full: 'Dataset', numeric: false },
  { short: 'ウィンドウ (s)', full: 'Analysis Window Size (s)', numeric: true },
  ...STANDARD_HEADERS.slice(1),
] as const

export interface StatisticsPanelProps {
  datasets: readonly Dataset[]
  mode: ViewMode
}

export function StatisticsPanel(props: StatisticsPanelProps): React.JSX.Element {
  const showGQuality = isGQuality(props.mode)
  const headers = showGQuality ? G_QUALITY_HEADERS : STANDARD_HEADERS

  return (
    <section className="panel" aria-label={showGQuality ? 'G-quality評価テーブル' : '統計データテーブル'}>
      <div className="panel__header">
        <h2 className="panel__title">{showGQuality ? 'G-quality 評価' : '統計'}</h2>
        <span className="panel__hint">
          {showGQuality ? 'ウィンドウ幅ごとの最小標準偏差' : `解析ウィンドウ内の最小標準偏差`}
        </span>
      </div>
      <div {...TABLE_SCROLL_PROPS}>
        <table className="data-table">
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header.full} title={header.full} className={header.numeric ? 'numeric' : undefined}>
                  {header.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{showGQuality ? gQualityRows(props.datasets) : standardRows(props.datasets)}</tbody>
        </table>
      </div>
    </section>
  )
}

function standardRows(datasets: readonly Dataset[]): React.JSX.Element[] {
  return datasets.map((dataset) => (
    <tr key={dataset.name}>
      <td>{dataset.name}</td>
      <td className="numeric">{formatSeconds(dataset.statistics.inner.startTime)}</td>
      <td className="numeric">{formatFixed(dataset.statistics.inner.mean)}</td>
      <td className="numeric">{formatFixed(dataset.statistics.inner.std)}</td>
      <td className="numeric">{formatSeconds(dataset.statistics.drag.startTime)}</td>
      <td className="numeric">{formatFixed(dataset.statistics.drag.mean)}</td>
      <td className="numeric">{formatFixed(dataset.statistics.drag.std)}</td>
    </tr>
  ))
}

function gQualityRows(datasets: readonly Dataset[]): React.JSX.Element[] {
  const rows: React.JSX.Element[] = []
  for (const dataset of datasets) {
    for (const row of dataset.gQuality) {
      rows.push(
        <tr key={`${dataset.name}:${row.windowSize}`}>
          <td>{dataset.name}</td>
          <td className="numeric">{formatSeconds(row.windowSize)}</td>
          <td className="numeric">{formatSeconds(row.innerStartTime)}</td>
          <td className="numeric">{formatFixed(row.innerMean)}</td>
          <td className="numeric">{formatFixed(row.innerStd)}</td>
          <td className="numeric">{formatSeconds(row.dragStartTime)}</td>
          <td className="numeric">{formatFixed(row.dragMean)}</td>
          <td className="numeric">{formatFixed(row.dragStd)}</td>
        </tr>,
      )
    }
  }
  return rows
}
