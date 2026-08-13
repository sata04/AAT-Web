/**
 * The poster renderer's kill switch, and the two different confirmations it needs.
 *
 * One control, two asymmetric actions, so one confirmation shape would be wrong for one of them:
 *
 *  - **Opening it** stops poster generation for the entire deployment. Every researcher's
 *    「生成」 button starts answering POSTER_BUSY, and nothing tells them why unless the operator
 *    types a reason. That is a deliberate service change, so it goes behind
 *    {@link AdminConfirmDialog} — the typed phrase — and the reason field is required rather than
 *    optional: a breaker found open with `reason: null` two weeks later is indistinguishable from a
 *    misclick, and the next operator has no way to know whether closing it is safe.
 *  - **Closing it** resumes container spend and, more importantly, overrides a decision somebody
 *    else made. So the confirmation is lighter but shows *their* reason back: the question worth
 *    asking is not "are you sure" but "the renderer was stopped because ⟨reason⟩ — has that been
 *    resolved?".
 *
 * Neither action touches local analysis, and the dialogs say so. A researcher whose poster is
 * refused still has their analysis, their graph, their statistics and their Excel export; the
 * renderer is the one part of AAT that is genuinely optional twice over.
 */

import { useState } from 'react'
import { formatMoment } from '../admin/format.ts'
import { presentBreaker } from '../admin/renderer.ts'
import { type CircuitBreakerState, setRendererBreaker } from '../cloud/gateway.ts'
import { AdminConfirmDialog } from './AdminConfirmDialog.tsx'
import { Dialog } from './Dialog.tsx'

/** What the operator must type to stop poster generation for everybody. */
export const BREAKER_CONFIRM_PHRASE = 'ポスター生成を停止'

export interface AdminBreakerControlProps {
  state: CircuitBreakerState
  /** Called with the state the server returned, so the screen shows what was stored. */
  onChanged: (state: CircuitBreakerState) => void
  /** Surfaced by the screen; this component never renders a bare failure of its own. */
  onFailure: (message: string) => void
}

export function AdminBreakerControl(props: AdminBreakerControlProps): React.JSX.Element {
  const [pending, setPending] = useState<'open' | 'close' | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const presentation = presentBreaker(props.state)

  const apply = async (open: boolean, why: string | null) => {
    setBusy(true)
    const outcome = await setRendererBreaker(open, why)
    setBusy(false)
    if (!outcome.ok) {
      props.onFailure(outcome.message)
      return
    }
    setPending(null)
    setReason('')
    props.onChanged(outcome.value.circuitBreaker)
  }

  return (
    <div className="admin-breaker">
      <dl className="admin-facts">
        <div className="admin-facts__row">
          <dt>状態</dt>
          {/* The status word carries the state; the class only tints it. A monochrome screen, a
              screenshot in a report and a screen reader all get the same answer. */}
          <dd>
            <span className={props.state.open ? 'admin-flag admin-flag--bad' : 'admin-flag admin-flag--good'}>
              {presentation.label}
            </span>
          </dd>
        </div>
        <div className="admin-facts__row">
          <dt>意味</dt>
          <dd>{presentation.consequence}</dd>
        </div>
        <div className="admin-facts__row">
          <dt>停止の理由</dt>
          <dd>{props.state.reason === null || props.state.reason === '' ? '—' : props.state.reason}</dd>
        </div>
        <div className="admin-facts__row">
          <dt>最終変更</dt>
          <dd>{formatMoment(props.state.updatedAt)}</dd>
        </div>
      </dl>

      <div className="screen__actions">
        {props.state.open ? (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => setPending('close')}
          >
            ポスター生成を再開する
          </button>
        ) : (
          <button type="button" className="button" disabled={busy} onClick={() => setPending('open')}>
            ポスター生成を停止する
          </button>
        )}
      </div>

      {pending === 'open' ? (
        <AdminConfirmDialog
          title="ポスター生成をデプロイ全体で停止します"
          description={
            'このデプロイのすべての利用者について、ポスター図の生成が停止します。\n' +
            '生成の要求は POSTER_BUSY で拒否され、レンダリング用コンテナは呼び出されません。\n' +
            'すでに生成済みの図と、ローカルの解析・グラフ・Excel書き出しには影響しません。'
          }
          confirmPhrase={BREAKER_CONFIRM_PHRASE}
          confirmLabel="停止する"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(true, reason.trim() === '' ? null : reason.trim())}
        >
          <div className="dialog__section">
            <label className="field">
              <span className="field__label">停止の理由（必須・次に見る人が読みます）</span>
              <input
                className="input"
                type="text"
                maxLength={200}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <p className="panel__hint">
              理由は system_flags に保存され、監査ログの renderer.circuit_breaker
              にも記録されます。空のまま停止すると、後から見た運用者には誤操作と区別できません。
            </p>
          </div>
        </AdminConfirmDialog>
      ) : null}

      {pending === 'close' ? (
        <Dialog
          title="ポスター生成を再開します"
          description={
            props.state.reason === null || props.state.reason === ''
              ? '停止の理由は記録されていません。停止した運用者に確認してから再開してください。'
              : `停止の理由: ${props.state.reason}\nこの問題が解決したことを確認してから再開してください。`
          }
          onClose={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                className="button button--flat"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void apply(false, null)}
              >
                {busy ? '実行しています…' : '再開する'}
              </button>
            </>
          }
        >
          <p className="panel__hint">
            再開すると、以降のポスター生成要求はレンダリング用コンテナに渡されます。コンテナの起動時間と実行時間はそのまま費用になります。
          </p>
        </Dialog>
      ) : null}
    </div>
  )
}
