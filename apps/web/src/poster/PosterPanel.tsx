/**
 * The poster panel: the automatic figure's state, and the way to ask for a custom one.
 *
 * Two things this component deliberately does *not* do.
 *
 * It never starts a render. Everything it shows is a read — the automatic poster's lane state,
 * which the sync path already produced, and an `<img>` of a finished figure, whether its PNG came
 * back from the Worker or was drawn by the local engine a moment ago. Looking at a poster,
 * scrolling past it, or re-rendering the panel for an unrelated state change draws nothing. The
 * only path that can start a render is behind a button a human presses, or the once-per-revision
 * automatic request that the completed cloud sync makes.
 *
 * And it never implies that a poster is part of the analysis. The figure is drawn on this machine
 * — no account, network or cloud half is needed for that — so the panel stays quiet and usable
 * in exactly those states; the cloud copy is an upload of a finished local image, not the way the
 * image comes to be. What it still says honestly is what is true: a formal figure is built from a
 * run's identity, so a filename that cannot yield a run code gets no poster.
 */

import { useState } from 'react'
import type { PosterStatus } from '../cloud/status.ts'
import { posterLabel } from '../cloud/status.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { PosterEntry } from './entry.ts'
import { PosterDialog } from './PosterDialog.tsx'
import type { PosterContext } from './requests.ts'

export interface PosterPanelProps {
  /** Null only when the active file's name cannot yield a run code. */
  context: PosterContext | null
  /** Why there is no context, phrased for a researcher. Null while there is one. */
  unavailableReason: string | null
  /** The automatic poster's lane, shared with the status bar. */
  status: PosterStatus
  selection: SelectionRange | null
  selectionEnabled: boolean
  /**
   * The analysis config's `ylim_min` / `ylim_max`, so the custom-poster dialog opens on the same
   * gravity-level frame the graph above it is drawn in. Only the *custom* dialog reads it — the
   * automatic poster is derived from the revision alone and takes the frozen preset's range, or it
   * would stop being derivable from the revision alone.
   */
  yRange: { min: number; max: number }
  onRetryAuto: () => void
  /** Figures created in this session, newest first. History also lives on the server when stored. */
  customPosters: readonly PosterEntry[]
  onCustomCreated: (poster: PosterEntry) => void
  /** A custom render that failed after its dialog was closed — routed to the notice stack. */
  onCustomFailed?: ((message: string) => void) | undefined
}

/** What the in-flight lane is doing, one honest sentence per state. */
function progressHint(status: PosterStatus): string | null {
  switch (status.kind) {
    case 'loading':
      // The Pyodide runtime is tens of MB on first use; saying so beats a silent wait.
      return '描画エンジンを読み込んでいます。初回のみ数十MBの取得が入ります。'
    case 'rendering':
      return 'ポスター図を生成しています。'
    case 'uploading':
      return '作成した図をクラウドに保存しています。'
    default:
      return null
  }
}

export function PosterPanel(props: PosterPanelProps): React.JSX.Element {
  const { context, status } = props
  const [dialogOpen, setDialogOpen] = useState(false)

  const label = posterLabel(status)
  const canCreate = context !== null
  const progress = progressHint(status)

  return (
    <section className="panel" aria-label="ポスター図">
      <div className="panel__header">
        <h2 className="panel__title">ポスター図</h2>
        <span className="panel__hint">{label.text}</span>
      </div>

      {context === null ? (
        <p className="panel__hint">
          {props.unavailableReason ??
            'ファイルを開くと、デスクトップ版と同じ体裁のポスター図を作成できます。'}
        </p>
      ) : (
        <>
          <p className="panel__hint">
            {context.revisionId === null
              ? 'ポスター図はこのブラウザで描画され、PNG として保存できます。サインインして解析結果をクラウドに保存すると、図もそこに記録されます。'
              : '自動ポスター図は解析1件につき1枚だけ作られます。表示しても再生成はされません。'}
          </p>

          {progress === null ? null : (
            <p className="panel__hint" role="status">
              {progress}
            </p>
          )}

          {status.kind === 'ready' ? (
            <>
              <img
                src={status.url}
                alt={`${context.runCode} の自動ポスター図`}
                style={{ maxWidth: '100%', height: 'auto', background: '#ffffff' }}
              />
              <p className="panel__hint">
                <a href={status.url} target="_blank" rel="noreferrer">
                  元のサイズで開く
                </a>
                {'　'}
                <a href={status.url} download={`${context.runCode}_poster.png`}>
                  PNG を保存
                </a>
              </p>
            </>
          ) : null}

          {status.kind === 'failed' ? (
            <div className="notice notice--warning" role="status">
              <div className="notice__body">
                <p>{status.message}</p>
                <p>解析結果とグラフはそのまま利用できます。</p>
                {status.retryable ? (
                  <button type="button" className="button" onClick={props.onRetryAuto}>
                    自動ポスター図を再試行
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}

      <div>
        <button type="button" className="button" disabled={!canCreate} onClick={() => setDialogOpen(true)}>
          正式ポスター図を作成
        </button>
        {canCreate && props.selection === null ? (
          <p className="panel__hint">
            {props.selectionEnabled
              ? 'グラフ上をドラッグして範囲を選んでおくと、その範囲が初期値になります。'
              : '通常表示に戻ると、グラフ上で範囲を選べます。'}
          </p>
        ) : null}
      </div>

      {props.customPosters.length === 0 ? null : (
        <>
          <h3 className="panel__title">作成した図</h3>
          <ul className="dataset-list">
            {props.customPosters.map((poster) => (
              <li className="dataset-list__item" key={poster.posterId ?? poster.createdAt}>
                <a className="dataset-list__name" href={poster.imageUrl} target="_blank" rel="noreferrer">
                  {new Date(poster.createdAt).toLocaleString('ja-JP')}
                </a>
                <span className="panel__hint">
                  {poster.presetVersion}
                  {poster.posterId === null ? '（未保存）' : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {dialogOpen && context !== null ? (
        <PosterDialog
          context={context}
          selection={props.selection}
          yRange={props.yRange}
          onClose={() => setDialogOpen(false)}
          onCreated={props.onCustomCreated}
          onFailed={props.onCustomFailed}
        />
      ) : null}
    </section>
  )
}
