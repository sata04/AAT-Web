/**
 * The poster panel: the automatic figure's state, and the way to ask for a custom one.
 *
 * Two things this component deliberately does *not* do.
 *
 * It never starts a render. Everything it shows is a read — the automatic poster's lane state,
 * which the sync path already produced, and `<img src>` against `GET /posters/:id/image`, which
 * streams a stored PNG through the Worker. Looking at a poster, scrolling past it, or React
 * re-rendering the panel for an unrelated state change costs a container nothing. The only request
 * that can start a render is behind a button a human presses, or the once-per-revision automatic
 * request that the completed cloud sync makes.
 *
 * And it never implies that a poster is part of the analysis. The panel is empty and quiet when
 * there is no account, no network, or no cloud half deployed; the graph, the statistics, the range
 * selection and the Excel export are all finished and usable in exactly that state. What the panel
 * says in that case is what is true — a formal figure needs the renderer — and not "sign in to
 * continue".
 */

import { useState } from 'react'
import type { PosterFigure } from '../cloud/gateway.ts'
import { posterImageUrl } from '../cloud/gateway.ts'
import { type PosterStatus, posterLabel } from '../cloud/status.ts'
import type { SelectionRange } from '../graph/selection.ts'
import { PosterDialog } from './PosterDialog.tsx'
import type { PosterContext } from './requests.ts'

export interface PosterPanelProps {
  /** Null until an analysis has been stored in the cloud; the poster is drawn from a revision. */
  context: PosterContext | null
  /** Why there is no context, phrased for a researcher. Null while there is one. */
  unavailableReason: string | null
  /** The automatic poster's lane, shared with the status bar. */
  status: PosterStatus
  selection: SelectionRange | null
  selectionEnabled: boolean
  onRetryAuto: () => void
  /** Custom figures created in this session, newest first. History lives on the server too. */
  customPosters: readonly PosterFigure[]
  onCustomCreated: (poster: PosterFigure) => void
}

export function PosterPanel(props: PosterPanelProps): React.JSX.Element {
  const { context, status } = props
  const [dialogOpen, setDialogOpen] = useState(false)

  const label = posterLabel(status)
  const canCreate = context !== null

  return (
    <section className="panel" aria-label="ポスター図">
      <div className="panel__header">
        <h2 className="panel__title">ポスター図</h2>
        <span className="panel__hint">{label.text}</span>
      </div>

      {context === null ? (
        <p className="panel__hint">
          {props.unavailableReason ??
            '解析結果をクラウドに保存すると、デスクトップ版と同じ体裁のポスター図を作成できます。'}
        </p>
      ) : (
        <>
          <p className="panel__hint">
            自動ポスター図は解析1件につき1枚だけ作られます。表示しても再生成はされません。
          </p>

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
              <li className="dataset-list__item" key={poster.posterId}>
                <a
                  className="dataset-list__name"
                  href={posterImageUrl(poster.posterId)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {new Date(poster.createdAt).toLocaleString('ja-JP')}
                </a>
                <span className="panel__hint">{poster.presetVersion}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {dialogOpen && context !== null ? (
        <PosterDialog
          context={context}
          selection={props.selection}
          onClose={() => setDialogOpen(false)}
          onCreated={props.onCustomCreated}
        />
      ) : null}
    </section>
  )
}
