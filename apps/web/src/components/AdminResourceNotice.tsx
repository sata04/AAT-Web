/**
 * How a panel says "loading", "refused" and "there is nothing here" — in words, every time.
 *
 * The three states share a component because they are one decision made once: an operator looking
 * at a storage report has to be able to tell "no user has stored anything" from "the storage report
 * could not be read", and the only thing that separates those on screen is text. A spinner would
 * separate the first from the second and not the second from the third; an empty table separates
 * none of them.
 *
 * Announcement is deliberate rather than incidental. Loading is `role="status"` with
 * `aria-live="polite"` — an update worth hearing when the reader gets to it — while a failure is
 * `role="alert"`, which interrupts, because a panel that failed is a panel whose numbers are not on
 * screen and a reader who does not hear that will read the surrounding page as complete.
 */

import { type AdminResource, describeFailure } from '../admin/resource.ts'

export interface AdminResourceNoticeProps {
  /** The resource whose non-ready states are rendered. Renders nothing when it is ready. */
  resource: AdminResource<unknown>
  /** What is being loaded, e.g. 「利用者一覧」. Used in the loading and failure sentences. */
  label: string
  /** Offered only when the failure is one a retry could fix. */
  onRetry?: (() => void) | undefined
  /**
   * False when the caller never asked for this resource because the session lacks its capability.
   *
   * `useAdminResource` leaves a disabled resource in `loading` — correctly, since it is not ready
   * and never will be — so without this the panel would sit under an `AdminCapabilityNotice`
   * claiming to be loading something it has deliberately not requested. Two contradictory sentences
   * about the same panel is worse than either alone.
   */
  enabled?: boolean | undefined
}

export function AdminResourceNotice(props: AdminResourceNoticeProps): React.JSX.Element | null {
  if (props.enabled === false) return null
  if (props.resource.kind === 'ready') return null

  if (props.resource.kind === 'loading') {
    return (
      <p className="panel__hint" role="status" aria-live="polite">
        {props.label}を読み込んでいます…
      </p>
    )
  }

  const advice = describeFailure(props.resource)
  if (advice === null) return null

  return (
    <div className="notice notice--error" role="alert">
      <span className="notice__body">
        {props.label}を表示できません。{advice.summary}
      </span>
      {advice.retryable && props.onRetry !== undefined ? (
        <button type="button" className="button button--flat" onClick={props.onRetry}>
          再試行
        </button>
      ) : null}
    </div>
  )
}

/**
 * The row a table shows when it loaded successfully and there was nothing in it.
 *
 * A `<tr>` rather than a paragraph beside the table, so the answer sits where the reader is already
 * looking and the table keeps its own structure — a table with a heading row and no body row reads,
 * to a screen reader walking the grid, as a table that failed to render.
 */
export function AdminEmptyRow(props: { columns: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <tr>
      <td colSpan={props.columns}>{props.children}</td>
    </tr>
  )
}
