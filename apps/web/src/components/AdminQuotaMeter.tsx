/**
 * How full one account is, as the one ratio in this console that earns a picture.
 *
 * `src/styles/tokens.css` describes this application as a quiet instrument panel rather than a
 * dashboard, and the admin endpoints return counts and sizes — plotting those would be decoration.
 * A *proportion* is the exception: "820 MiB of 1 GiB" is arithmetic the reader has to do, and the
 * whole question "is this account about to start failing uploads" is that arithmetic.
 *
 * A native `<meter>` rather than a styled `<div>`: it carries its own role and its own value/max
 * semantics, so an assistive technology announces the proportion rather than an unlabelled bar. The
 * element is not sufficient on its own, though — `<meter>`'s own low/high/optimum colouring is the
 * classic status-by-colour failure — so the percentage and a word (余裕あり / 残りわずか / 上限間近 /
 * 上限超過) sit next to it. Colour is the third channel here, never the first.
 *
 * `bytesReserved` is inside the fill deliberately. `docs/cloud-data-model.md`'s reservation
 * protocol tests `bytes_used + bytes_reserved + declared <= bytes_limit`, so a user with a stuck
 * reservation has less room than their usage suggests — and a meter that disagreed with the server
 * would do so at exactly the moment somebody is asking why their upload was refused.
 */

import { formatBytes, quotaPressure, remainingBytes } from '../admin/format.ts'

export interface AdminQuotaMeterProps {
  used: number
  reserved: number
  limit: number
  /** Named for the account it describes, so the meter is not an anonymous bar in a table row. */
  label: string
}

export function AdminQuotaMeter(props: AdminQuotaMeterProps): React.JSX.Element {
  const pressure = quotaPressure(props.used, props.reserved, props.limit)
  const remaining = remainingBytes(props.used, props.reserved, props.limit)

  return (
    <div className={`admin-meter admin-meter--${pressure.level}`}>
      <meter
        className="admin-meter__bar"
        min={0}
        max={1}
        value={pressure.ratio ?? 0}
        aria-label={`${props.label} の保存容量使用率`}
      >
        {pressure.percentText}
      </meter>
      <span className="admin-meter__text">
        {formatBytes(props.used)} / {formatBytes(props.limit)}（{pressure.percentText}・{pressure.label}）
      </span>
      <span className="admin-meter__detail">
        {props.reserved > 0 ? `予約中 ${formatBytes(props.reserved)}・` : ''}
        残り {formatBytes(remaining)}
      </span>
    </div>
  )
}
