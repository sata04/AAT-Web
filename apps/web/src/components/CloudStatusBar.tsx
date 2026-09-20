/**
 * The three-lane status bar.
 *
 * Analysis, Cloud sync and Poster figure are shown side by side because they are
 * genuinely independent: a finished local analysis is the primary success, and
 * nothing the cloud does — or fails to do — changes that. There is deliberately
 * no combined "status" here and no overlay anywhere: a poster container starting
 * up must never look like the application being busy.
 *
 * Failures state what failed, in which lane, and offer a retry for the ones that
 * are worth retrying. The local results stay on screen throughout.
 */

import {
  analysisLabel,
  type CloudStatuses,
  posterLabel,
  retryableLanes,
  type StatusLabel,
  syncLabel,
} from '../cloud/status.ts'

export interface CloudStatusBarProps {
  statuses: CloudStatuses
  /**
   * The file the cloud and poster lanes are talking about. The lanes are
   * global, not per-dataset, so when this is not the active file the subject
   * is named explicitly rather than letting a status look like it belongs to
   * the file on screen.
   */
  cloudSubject: string | null
  activeName: string | null
  onRetrySync: () => void
  onRetryPoster: () => void
}

function Lane(props: { name: string; label: StatusLabel; hint?: string }): React.JSX.Element {
  return (
    <span className="status-lane" title={props.hint}>
      <span className={`status-lane__dot status-lane__dot--${props.label.tone}`} aria-hidden="true" />
      <span>{props.name}</span>
      <span className="status-lane__value">{props.label.text}</span>
    </span>
  )
}

export function CloudStatusBar(props: CloudStatusBarProps): React.JSX.Element {
  const { statuses } = props
  const failureMessage =
    statuses.analysis.kind === 'failed'
      ? statuses.analysis.message
      : statuses.sync.kind === 'failed'
        ? statuses.sync.message
        : statuses.poster.kind === 'failed'
          ? statuses.poster.message
          : null
  // Name the file the cloud lanes describe when it is not the one on screen —
  // a "saved" for dataset A must not read as if B were synced.
  const remoteSubject =
    props.cloudSubject !== null && props.cloudSubject !== props.activeName ? ` (${props.cloudSubject})` : ''
  const retryable = retryableLanes(statuses)

  return (
    <footer className="status-bar">
      <h2 className="visually-hidden">状態</h2>
      {/* Polite: a status change must never interrupt what the user is reading. */}
      <div className="status-lane" role="status" aria-live="polite">
        <Lane name="解析" label={analysisLabel(statuses.analysis)} />
      </div>
      <Lane
        name={`クラウド同期${remoteSubject}`}
        label={syncLabel(statuses.sync)}
        hint="サインインした場合だけ、解析結果をクラウドへ保存します。ローカル解析とは独立しています。"
      />
      <Lane
        name={`ポスター図${remoteSubject}`}
        label={posterLabel(statuses.poster)}
        hint="クラウドに保存した解析から、デスクトップ版と同じ体裁の図を生成します。"
      />

      {retryable.includes('sync') ? (
        <button type="button" className="button button--flat" onClick={props.onRetrySync}>
          同期を再試行
        </button>
      ) : null}
      {retryable.includes('poster') ? (
        <button type="button" className="button button--flat" onClick={props.onRetryPoster}>
          ポスターを再試行
        </button>
      ) : null}

      {failureMessage === null ? null : <span className="status-lane__value">{failureMessage}</span>}
    </footer>
  )
}
