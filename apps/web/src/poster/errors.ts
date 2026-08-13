/**
 * Turning a poster refusal into something a researcher can act on.
 *
 * `@aat/plot-spec` refuses *before* it assembles a document, with a `PosterSpecError` carrying a
 * stable `code`, both locales of prose, and a structured `details` payload. That structure is the
 * whole point of it: "この範囲には 431,278 点あります。0.67 秒くらいまで狭めてください" is a
 * sentence somebody can act on, and `data.inner.time: array has 431278 points, exceeding the
 * 200000-point cap` is not — nor is `[object Object]`, which is what showing the error directly
 * eventually produces.
 *
 * So nothing in the poster UI ever renders a caught value. Every refusal comes through here, is
 * matched on its `code`, and comes out as a Japanese sentence plus — where the details support one
 * — a concrete *action* the dialog can offer as a button:
 *
 *  - `POSTER_RANGE_TOO_MANY_POINTS` carries `estimatedMaxSpanSeconds`, so the offer is "narrow the
 *    selection to about that span" rather than "narrow the selection".
 *  - `POSTER_RANGE_EMPTY` carries `dataMinTime` / `dataMaxTime`, so the offer is "move to where the
 *    data actually is" rather than "there is no data here".
 *
 * Everything else gets the code's own message and no button, because there is nothing the dialog
 * could press on the user's behalf that would be honest.
 */

import { isPosterSpecError, type PosterSpecErrorCode } from '@aat/plot-spec'
import { formatFixed } from '../app/format.ts'

/** A one-press remedy the dialog can offer alongside the message. */
export type PosterRangeAction =
  | {
      kind: 'narrow-range'
      label: string
      /** Seconds. Keep `xMin`, move `xMax` to `xMin + maxSpanSeconds`. */
      maxSpanSeconds: number
    }
  | {
      kind: 'move-to-data'
      label: string
      xMin: number
      xMax: number
    }

export interface PosterSpecAdvice {
  /** `'UNKNOWN'` for anything that is not a `PosterSpecError` — a bug here, not bad input. */
  code: PosterSpecErrorCode | 'UNKNOWN'
  /** Japanese, ready to display verbatim. */
  message: string
  /** The numbers behind the message, when `details` carried any worth saying. */
  detail: string | null
  action: PosterRangeAction | null
}

const UNKNOWN_MESSAGE = 'ポスター図を作成できませんでした。設定を確認してください。'

/**
 * Describe a caught poster-building failure.
 *
 * Accepts `unknown` deliberately: this is called from a `catch`, and a `catch` binding is `unknown`
 * whatever the code above it promises. `isPosterSpecError` checks the `code` field rather than
 * using `instanceof`, so an error that crossed a Web Worker boundary as a structured clone is still
 * recognised.
 */
export function describePosterSpecError(error: unknown): PosterSpecAdvice {
  if (!isPosterSpecError(error)) {
    return { code: 'UNKNOWN', message: UNKNOWN_MESSAGE, detail: null, action: null }
  }

  const details = error.details ?? {}
  const message = error.messages.ja

  if (error.code === 'POSTER_RANGE_TOO_MANY_POINTS') {
    const points = numberOrNull(details.points)
    const maxPoints = numberOrNull(details.maxPoints)
    const span = numberOrNull(details.estimatedMaxSpanSeconds)
    const detail =
      points === null || maxPoints === null
        ? null
        : `選択範囲には ${points.toLocaleString('ja-JP')} 点あります（上限 ${maxPoints.toLocaleString('ja-JP')} 点）。`
    return {
      code: error.code,
      message,
      detail,
      // The estimate assumes an even sample spacing across the selection, which is what a
      // drop-tower recording has. It is a proposal the user can then adjust, not a promise.
      action:
        span === null || span <= 0
          ? null
          : {
              kind: 'narrow-range',
              label: `範囲を約 ${formatFixed(span, 3)} 秒に狭める`,
              maxSpanSeconds: span,
            },
    }
  }

  if (error.code === 'POSTER_RANGE_EMPTY') {
    const min = numberOrNull(details.dataMinTime)
    const max = numberOrNull(details.dataMaxTime)
    if (min === null || max === null || !(min < max)) {
      return { code: error.code, message, detail: null, action: null }
    }
    return {
      code: error.code,
      message,
      detail: `このセンサーのデータは ${formatFixed(min, 3)} 秒 ～ ${formatFixed(max, 3)} 秒です。`,
      action: {
        kind: 'move-to-data',
        label: 'データのある範囲に合わせる',
        xMin: min,
        xMax: max,
      },
    }
  }

  if (error.code === 'POSTER_PAYLOAD_TOO_LARGE') {
    const bytes = numberOrNull(details.bytes)
    const maxBytes = numberOrNull(details.maxBytes)
    return {
      code: error.code,
      message,
      detail:
        bytes === null || maxBytes === null
          ? null
          : `送信サイズは約 ${mebibytes(bytes)} MiB で、上限は ${mebibytes(maxBytes)} MiB です。`,
      action: null,
    }
  }

  if (error.code === 'POSTER_SERIES_MISSING') {
    const sensor = sensorName(details.sensor)
    return {
      code: error.code,
      message,
      detail: sensor === null ? null : `${sensor} のデータがこのファイルにはありません。`,
      action: null,
    }
  }

  return { code: error.code, message, detail: null, action: null }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mebibytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/** The equipment's names, spelled the way the legend, the exports and the desktop spell them. */
function sensorName(value: unknown): string | null {
  if (value === 'inner') return 'Inner Capsule'
  if (value === 'drag') return 'Drag Shield'
  return null
}
