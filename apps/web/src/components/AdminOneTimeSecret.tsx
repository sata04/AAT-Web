/**
 * The registration URL, shown for the only moment it exists.
 *
 * `POST /api/v1/admin/invitations` returns the plaintext token once. The database stores its
 * SHA-256 and nothing else, the listing route deliberately returns neither, and there is no route
 * that could re-derive it — so this panel is not "the convenient place to see the link", it is the
 * only place it will ever be. Everything below follows from that being irreversible:
 *
 *  - **The wording says so before the reader has clicked anything.** "後から再表示することはできません"
 *    sits above the field, not in a tooltip and not after the copy button, because a warning a
 *    reader meets after they have already dismissed the panel is not a warning.
 *  - **The URL is in a readonly `<input>`, not a `<code>` block.** It is selectable, focusable and
 *    reachable by keyboard, so a browser with no clipboard permission — or a reader who does not
 *    use a mouse — can still take it. The copy button is the convenience; the field is the
 *    mechanism.
 *  - **Dismissing is explicit and irreversible in the UI too.** The button says 閉じる（二度と表示され
 *    ません）rather than a bare ×, so closing it is a decision rather than a reflex.
 *  - **Nothing here is logged, stored or navigated to.** The token never enters the URL bar of this
 *    screen, never goes into `localStorage`, and is dropped from React state on dismissal. The same
 *    discipline `src/auth/invitation.ts` applies on the redemption side.
 *
 * The clipboard write is best-effort by construction: `navigator.clipboard` is absent in insecure
 * contexts and can be denied by permission policy, and a copy button that silently did nothing
 * would be the worst possible failure for a value that cannot be recovered. A refusal says so and
 * points at the field.
 */

import { useId, useState } from 'react'

export interface AdminOneTimeSecretProps {
  title: string
  /** One line of context: who this link is for, and what it does when it is opened. */
  description: string
  /** The full URL. Never truncated on screen — a half-copied credential is a support ticket. */
  url: string
  onDismiss: () => void
}

type CopyState = 'idle' | 'copied' | 'failed'

export function AdminOneTimeSecret(props: AdminOneTimeSecretProps): React.JSX.Element {
  const fieldId = useId()
  const [copyState, setCopyState] = useState<CopyState>('idle')

  const copy = async () => {
    try {
      const clipboard = navigator.clipboard
      if (clipboard === undefined) throw new Error('no clipboard')
      await clipboard.writeText(props.url)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <section className="panel panel--framed admin-secret" aria-label={props.title}>
      <div className="panel__header">
        <h2 className="panel__title">{props.title}</h2>
      </div>
      <p className="panel__hint">{props.description}</p>
      {/* An alert, not a status: this is the one moment the value exists, and a reader who is told
          about it only when they happen to reach it has already lost it. */}
      <p className="notice notice--warning" role="alert">
        <span className="notice__body">
          このURLは今回だけ表示されます。保存先に控えてから閉じてください。サーバーには使い捨てトークンのハッシュだけが保存されており、後から再表示することはできません。
        </span>
      </p>
      <label className="field" htmlFor={fieldId}>
        <span className="field__label">登録用URL</span>
      </label>
      <input
        id={fieldId}
        className="input admin-secret__url"
        type="text"
        readOnly
        value={props.url}
        // Selecting the whole value on focus makes the keyboard path (Tab, Ctrl+C) as short as the
        // button, which matters because the button is the half that can be refused.
        onFocus={(event) => event.currentTarget.select()}
      />
      <p className="panel__hint" role="status">
        {copyState === 'copied'
          ? 'クリップボードにコピーしました。'
          : copyState === 'failed'
            ? 'クリップボードにコピーできませんでした。上の欄を選択して手動でコピーしてください。'
            : '上の欄は選択してコピーできます。'}
      </p>
      <div className="screen__actions">
        <button type="button" className="button button--primary" onClick={() => void copy()}>
          URLをコピー
        </button>
        <button type="button" className="button button--flat" onClick={props.onDismiss}>
          閉じる（二度と表示されません）
        </button>
      </div>
    </section>
  )
}
