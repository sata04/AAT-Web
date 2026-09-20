/**
 * Column selection — a port of `gui/column_selector_dialog.py`.
 *
 * Opened when detection is ambiguous, when a configured column is missing from
 * the file, or on demand from the toolbar. Both of the desktop's validation
 * rules are kept, and both are about preventing a plausible-looking wrong
 * result rather than a crash: at least one sensor must be enabled, and the two
 * sensors may not read the same column — analysing one series twice would report
 * perfect agreement between two sensors that are the same sensor.
 */

import { useMemo, useState } from 'react'
import { AMBIGUITY_MESSAGES, MAPPING_PROBLEM_MESSAGES, validateMapping } from '../analysis/mapping.ts'
import type { ColumnAmbiguity, ColumnMapping, OpenedSource } from '../analysis/protocol.ts'
import { Dialog } from './Dialog.tsx'

export interface ColumnSelectorDialogProps {
  source: OpenedSource
  initial: ColumnMapping
  /** Overrides the detected explanation, e.g. after a COLUMN_NOT_FOUND error. */
  reason?: string | undefined
  onCancel: () => void
  onConfirm: (mapping: ColumnMapping) => void
}

function describe(ambiguity: ColumnAmbiguity | null, reason: string | undefined): string {
  if (reason !== undefined) return reason
  if (ambiguity === null) {
    return '使用する列を選択してください。\n選択した列名はAcceleration dataの保存にも使用されます。'
  }
  return AMBIGUITY_MESSAGES[ambiguity]
}

/**
 * Split a select's options into "the detector proposes these" and "every other
 * column". The grouping is how the detector's confidence is shown: candidates
 * sit under 検出候補, and a user who disagrees still has every column under
 * すべての列 — the detector is a heuristic, not a gate.
 */
function optionGroups(detected: readonly string[], all: readonly string[]) {
  const detectedSet = new Set(detected)
  return {
    detected: detected.filter((column) => all.includes(column)),
    rest: all.filter((column) => !detectedSet.has(column)),
  }
}

function ColumnOptions({ groups }: { groups: ReturnType<typeof optionGroups> }) {
  return (
    <>
      {groups.detected.length === 0 ? null : (
        <optgroup label="検出候補">
          {groups.detected.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </optgroup>
      )}
      {groups.rest.length === 0 ? null : (
        <optgroup label="すべての列">
          {groups.rest.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </optgroup>
      )}
    </>
  )
}

export function ColumnSelectorDialog(props: ColumnSelectorDialogProps): React.JSX.Element {
  const [mapping, setMapping] = useState<ColumnMapping>(props.initial)
  const problem = useMemo(() => validateMapping(mapping), [mapping])

  const { detected, columnNames } = props.source
  const timeGroups = optionGroups(detected.time, columnNames)
  const accelerationGroups = optionGroups(detected.acceleration, columnNames)

  return (
    <Dialog
      title="データ列の選択"
      description={describe(props.source.ambiguity, props.reason)}
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="button button--flat" onClick={props.onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={problem !== null}
            onClick={() => props.onConfirm(mapping)}
          >
            OK
          </button>
        </>
      }
    >
      <div className="dialog__section">
        <label className="field">
          <span className="field__label">時間列</span>
          <select
            className="select"
            value={mapping.timeColumn}
            onChange={(event) => setMapping({ ...mapping, timeColumn: event.target.value })}
          >
            <ColumnOptions groups={timeGroups} />
          </select>
          <span className="panel__hint">グラフの横軸（秒）になる列です。</span>
        </label>
      </div>

      <hr className="separator" />

      <div className="dialog__section">
        <div className="checkbox-row">
          <label htmlFor="use-inner">Inner Capsule のデータを使用する</label>
          <input
            id="use-inner"
            type="checkbox"
            checked={mapping.useInner}
            onChange={(event) => setMapping({ ...mapping, useInner: event.target.checked })}
          />
        </div>
        <label className="field">
          <span className="field__label">内カプセル加速度列 (Inner Capsule)</span>
          <select
            className="select"
            value={mapping.innerColumn}
            disabled={!mapping.useInner}
            onChange={(event) => setMapping({ ...mapping, innerColumn: event.target.value })}
          >
            <ColumnOptions groups={accelerationGroups} />
          </select>
          <span className="panel__hint">落下する実験部（内カプセル）の加速度計の列です。</span>
        </label>
      </div>

      <hr className="separator" />

      <div className="dialog__section">
        <div className="checkbox-row">
          <label htmlFor="use-drag">Drag Shield のデータを使用する</label>
          <input
            id="use-drag"
            type="checkbox"
            checked={mapping.useDrag}
            onChange={(event) => setMapping({ ...mapping, useDrag: event.target.checked })}
          />
        </div>
        <label className="field">
          <span className="field__label">外カプセル加速度列 (Drag Shield)</span>
          <select
            className="select"
            value={mapping.dragColumn}
            disabled={!mapping.useDrag}
            onChange={(event) => setMapping({ ...mapping, dragColumn: event.target.value })}
          >
            <ColumnOptions groups={accelerationGroups} />
          </select>
          <span className="panel__hint">
            空気抵抗を受ける外側の殻（ドラッグシールド）の加速度計の列です。
          </span>
        </label>
      </div>

      {problem === null ? null : (
        <p className="notice notice--warning" role="alert">
          <span className="notice__body">{MAPPING_PROBLEM_MESSAGES[problem]}</span>
        </p>
      )}
    </Dialog>
  )
}
