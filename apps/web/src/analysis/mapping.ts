/**
 * Turning detected column candidates into a usable mapping.
 *
 * The desktop opens `ColumnSelectorDialog` for every file, unconditionally. That
 * is defensible for a tool driven one file at a time, and unbearable for a drag
 * of twenty. Here the dialog appears when the answer is genuinely in doubt, and
 * is reachable on demand the rest of the time.
 *
 * "In doubt" is defined narrowly on purpose. Guessing wrong does not produce an
 * error — it produces a plausible graph of the wrong column — so anything other
 * than the one unambiguous layout asks.
 */

import type { DetectedColumns } from '@aat/analysis-core'
import type { ColumnAmbiguity, ColumnMapping } from './protocol.ts'

export interface MappingProposal {
  mapping: ColumnMapping | null
  ambiguity: ColumnAmbiguity | null
}

/**
 * Propose a mapping, or explain why the user has to choose.
 *
 * Confident only for the canonical AAT layout: exactly one time candidate and
 * exactly two acceleration candidates, which is what a drop-tower logger writes
 * (time, Inner Capsule, Drag Shield). Everything else is a question.
 */
export function proposeMapping(detected: DetectedColumns): MappingProposal {
  const time = detected.time
  const acceleration = detected.acceleration

  if (time.length === 0) return { mapping: null, ambiguity: 'NO_TIME_CANDIDATE' }
  if (acceleration.length === 0) return { mapping: null, ambiguity: 'NO_ACCELERATION_CANDIDATE' }
  if (acceleration.length === 1) return { mapping: null, ambiguity: 'SINGLE_ACCELERATION_CANDIDATE' }
  if (time.length > 1 || acceleration.length > 2) {
    return { mapping: null, ambiguity: 'MULTIPLE_CANDIDATES' }
  }

  return {
    mapping: {
      timeColumn: time[0] as string,
      innerColumn: acceleration[0] as string,
      dragColumn: acceleration[1] as string,
      useInner: true,
      useDrag: true,
    },
    ambiguity: null,
  }
}

/**
 * The dialog's opening selection.
 *
 * Mirrors `ColumnSelectorDialog.__init__`: the second acceleration candidate is
 * pre-selected for the Drag Shield so the two sensors never start on the same
 * column, and a file with a single acceleration series starts with the Drag
 * Shield switched off rather than duplicating the Inner Capsule.
 */
export function defaultDialogMapping(detected: DetectedColumns): ColumnMapping {
  const time = detected.time[0] ?? ''
  const inner = detected.acceleration[0] ?? ''
  const hasSecond = detected.acceleration.length > 1
  return {
    timeColumn: time,
    innerColumn: inner,
    dragColumn: hasSecond ? (detected.acceleration[1] as string) : inner,
    useInner: true,
    useDrag: hasSecond,
  }
}

export type MappingProblem =
  | 'NO_SENSOR_ENABLED'
  | 'SAME_COLUMN_FOR_BOTH'
  | 'TIME_COLUMN_MISSING'
  | 'ACCELERATION_COLUMN_MISSING'

/**
 * `ColumnSelectorDialog.validate_and_accept`, as a pure check.
 *
 * Both rules come straight from the desktop: at least one sensor has to be
 * enabled, and the two sensors may not read the same column — analysing one
 * series twice would report a perfect agreement between two sensors that are
 * the same sensor.
 */
export function validateMapping(mapping: ColumnMapping): MappingProblem | null {
  if (!mapping.useInner && !mapping.useDrag) return 'NO_SENSOR_ENABLED'
  if (mapping.timeColumn === '') return 'TIME_COLUMN_MISSING'
  if (mapping.useInner && mapping.innerColumn === '') return 'ACCELERATION_COLUMN_MISSING'
  if (mapping.useDrag && mapping.dragColumn === '') return 'ACCELERATION_COLUMN_MISSING'
  if (mapping.useInner && mapping.useDrag && mapping.innerColumn === mapping.dragColumn) {
    return 'SAME_COLUMN_FOR_BOTH'
  }
  return null
}

/** Japanese explanations, matching the desktop's wording where it had one. */
export const MAPPING_PROBLEM_MESSAGES: Readonly<Record<MappingProblem, string>> = {
  NO_SENSOR_ENABLED: 'Inner CapsuleとDrag Shieldのどちらか一方は有効にしてください。',
  SAME_COLUMN_FOR_BOTH: 'Inner CapsuleとDrag Shieldには異なる加速度列を選択してください。',
  TIME_COLUMN_MISSING: '時間列を選択してください。',
  ACCELERATION_COLUMN_MISSING: '有効にしたセンサーの加速度列を選択してください。',
}

export const AMBIGUITY_MESSAGES: Readonly<Record<ColumnAmbiguity, string>> = {
  NO_TIME_CANDIDATE: '時間列の候補が見つかりませんでした。時間軸として使用する列を選択してください。',
  NO_ACCELERATION_CANDIDATE:
    '加速度列の候補が見つかりませんでした。加速度として使用する列を選択してください。',
  MULTIPLE_CANDIDATES:
    'CSVファイル内に複数の時間列または加速度列候補があります。\n使用する列を選択してください。',
  SINGLE_ACCELERATION_CANDIDATE:
    '加速度データが1系列だけ見つかりました。\n時間列を選び、どのセンサーを使用するか確認してください。\nDrag Shieldはデータ未検出のため初期状態で無効にしています。',
}
