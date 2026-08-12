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
  type StatusLabel,
  syncLabel,
} from '../cloud/status.ts'

export interface CloudStatusBarProps {
  statuses: CloudStatuses
  onRetrySync: () => void
  onRetryPoster: () => void
}

function Lane(props: { name: string; label: StatusLabel }): React.JSX.Element {
  return (
    <span className="status-lane">
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

  return (
    <footer className="status-bar" aria-label="状態">
      {/* Polite: a status change must never interrupt what the user is reading. */}
      <div className="status-lane" role="status" aria-live="polite">
        <Lane name="解析" label={analysisLabel(statuses.analysis)} />
      </div>
      <Lane name="クラウド同期" label={syncLabel(statuses.sync)} />
      <Lane name="ポスター図" label={posterLabel(statuses.poster)} />

      {statuses.sync.kind === 'failed' && statuses.sync.retryable ? (
        <button type="button" className="button button--flat" onClick={props.onRetrySync}>
          同期を再試行
        </button>
      ) : null}
      {statuses.poster.kind === 'failed' && statuses.poster.retryable ? (
        <button type="button" className="button button--flat" onClick={props.onRetryPoster}>
          ポスターを再試行
        </button>
      ) : null}

      {failureMessage === null ? null : <span className="status-lane__value">{failureMessage}</span>}
    </footer>
  )
}
