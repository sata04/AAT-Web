/**
 * Selected-range statistics.
 *
 * The desktop showed these in a modal (`RangeStatisticsDialog`) that had to be
 * dismissed before the graph could be touched again — so comparing two spans
 * meant remembering the first one's numbers. Here they live beside the graph and
 * update as the selection moves, and they travel into the exported workbook.
 *
 * The numeric inputs are not a nicety either: dragging cannot express "exactly
 * 0.2000 to 0.3000 s", and that is the span a method section has to quote.
 */

import { useEffect, useState } from 'react'
import { formatCount, formatFixed } from '../app/format.ts'
import type { RangeStatisticsResult } from '../app/range-statistics.ts'
import { MIN_SELECTION_SECONDS, type SelectionRange } from '../graph/selection.ts'

export interface RangeStatisticsPanelProps {
  selection: SelectionRange | null
  result: RangeStatisticsResult | null
  /** Disabled outside the normal single-dataset view, as on the desktop. */
  enabled: boolean
  onChange: (range: SelectionRange | null) => void
}

const ROWS = [
  { label: '有効データ点数', key: 'count', integer: true },
  { label: '欠損点数', key: 'missing', integer: true },
  { label: '平均値 (G)', key: 'mean', integer: false },
  { label: '絶対値平均 (G)', key: 'absMean', integer: false },
  { label: '標準偏差 (G)', key: 'std', integer: false },
  { label: '最小値 (G)', key: 'min', integer: false },
  { label: '最大値 (G)', key: 'max', integer: false },
] as const

function cell(
  statistics: RangeStatisticsResult['inner'] | null,
  key: (typeof ROWS)[number]['key'],
  integer: boolean,
): string {
  if (statistics === null || statistics.count === 0) return '—'
  const value = statistics[key]
  return integer ? formatCount(value) : formatFixed(value, 6)
}

export function RangeStatisticsPanel(props: RangeStatisticsPanelProps): React.JSX.Element {
  const { selection, result, enabled, onChange } = props
  // Local text state so a partially typed number is not coerced mid-keystroke.
  const [minText, setMinText] = useState('')
  const [maxText, setMaxText] = useState('')

  useEffect(() => {
    setMinText(selection === null ? '' : String(selection.xMin))
    setMaxText(selection === null ? '' : String(selection.xMax))
  }, [selection])

  const commit = (nextMin: string, nextMax: string) => {
    const xMin = Number(nextMin)
    const xMax = Number(nextMax)
    if (!Number.isFinite(xMin) || !Number.isFinite(xMax)) return
    onChange({ xMin: Math.min(xMin, xMax), xMax: Math.max(xMin, xMax) })
  }

  const innerStatistics = result === null ? null : result.inner
  const dragStatistics = result === null ? null : result.drag

  return (
    <section className="panel" aria-label="選択範囲の統計情報">
      <div className="panel__header">
        <h2 className="panel__title">選択範囲</h2>
        <span className="panel__hint">
          {enabled ? `${MIN_SELECTION_SECONDS} 秒未満の選択は無視されます` : 'このモードでは選択できません'}
        </span>
      </div>

      <div className="selection-readout">
        <label className="field">
          <span className="field__label">開始 (s)</span>
          <input
            className="input input--numeric"
            type="number"
            step="0.001"
            disabled={!enabled}
            value={minText}
            onChange={(event) => setMinText(event.target.value)}
            onBlur={() => commit(minText, maxText)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(minText, maxText)
            }}
          />
        </label>
        <label className="field">
          <span className="field__label">終了 (s)</span>
          <input
            className="input input--numeric"
            type="number"
            step="0.001"
            disabled={!enabled}
            value={maxText}
            onChange={(event) => setMaxText(event.target.value)}
            onBlur={() => commit(minText, maxText)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit(minText, maxText)
            }}
          />
        </label>
        <button
          type="button"
          className="button button--flat"
          disabled={!enabled || selection === null}
          onClick={() => onChange(null)}
        >
          選択を解除
        </button>
      </div>

      {selection === null ? (
        <p className="panel__hint">
          {enabled
            ? 'グラフ上をドラッグすると、その範囲の統計を計算します。'
            : '通常表示に戻ると範囲を選択できます。'}
        </p>
      ) : (
        <>
          <p className="panel__hint">
            選択範囲: {formatFixed(selection.xMin, 4)} 秒 ～ {formatFixed(selection.xMax, 4)} 秒 (範囲:{' '}
            {formatFixed(selection.xMax - selection.xMin, 4)} 秒)
          </p>
          {result !== null && result.empty ? (
            <p className="notice notice--warning" role="status">
              <span className="notice__body">選択範囲にデータがありません。</span>
            </p>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>統計量</th>
                    <th className="numeric">Inner Capsule</th>
                    <th className="numeric">Drag Shield</th>
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className="numeric">{cell(innerStatistics, row.key, row.integer)}</td>
                      <td className="numeric">{cell(dragStatistics, row.key, row.integer)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
