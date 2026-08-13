/**
 * The confirmation in front of an irreversible administrative action.
 *
 * Deleting a user removes their R2 objects and then cascades every row that references them; opening
 * the circuit breaker stops poster generation for the whole deployment; lowering a quota can leave
 * an account unable to upload. None of those is undone by pressing the button again, and a plain
 * "OK / Cancel" is not a decision — it is a reflex, and a reflex is exactly what fires when a dialog
 * appears under a cursor that was already moving.
 *
 * So this dialog asks for something a reflex cannot supply: the name of the thing being destroyed,
 * typed. Three properties follow, and all three are the point rather than decoration.
 *
 *  - **Enter does nothing.** `Dialog` moves focus to the first focusable element, which is this
 *    field, and the field swallows Enter explicitly. There is no `<form>` here, so there is no
 *    implicit submission to inherit; the `onKeyDown` guard is the belt to that braces, because a
 *    future refactor that wraps the content in a form would otherwise silently reintroduce
 *    "Enter destroys the account".
 *  - **The button is disabled until the phrase matches.** A disabled control is a hint and not a
 *    rule — the server is the authority for every action behind this dialog — but the hint is what
 *    makes the typed phrase a gate rather than a suggestion.
 *  - **The description states what will be destroyed, in specifics.** Not "この操作は取り消せません"
 *    on its own: which account, how many stored objects, what happens to the audit trail. A warning
 *    that does not name its object is a warning nobody can check.
 *
 * Escape and Cancel still close it. Dismissal is safe; it is *confirmation* that must not be
 * reachable by accident, and the two must not be conflated — a dialog that traps a reader who
 * opened it by mistake teaches them to click through the next one.
 */

import { useId, useState } from 'react'
import { Dialog } from './Dialog.tsx'

export interface AdminConfirmDialogProps {
  title: string
  /** What will be destroyed, named. Newlines are preserved by `.dialog__description`. */
  description: string
  /** The exact text the operator must type. Usually the display name of the thing being destroyed. */
  confirmPhrase: string
  /** The destructive button's label, e.g. 「削除する」. */
  confirmLabel: string
  busy?: boolean | undefined
  /** Extra consequences worth spelling out, rendered above the field. */
  children?: React.ReactNode
  onConfirm: () => void
  onCancel: () => void
}

export function AdminConfirmDialog(props: AdminConfirmDialogProps): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const fieldId = useId()
  const busy = props.busy === true
  const matched = typed.trim() === props.confirmPhrase.trim() && props.confirmPhrase.trim() !== ''

  return (
    <Dialog
      title={props.title}
      description={props.description}
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" className="button button--flat" disabled={busy} onClick={props.onCancel}>
            取消
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={busy || !matched}
            onClick={props.onConfirm}
          >
            {busy ? '実行しています…' : props.confirmLabel}
          </button>
        </>
      }
    >
      {props.children}
      <div className="dialog__section">
        <label className="field" htmlFor={fieldId}>
          <span className="field__label">
            続けるには <code>{props.confirmPhrase}</code> と入力してください
          </span>
        </label>
        <input
          id={fieldId}
          className="input"
          type="text"
          autoComplete="off"
          value={typed}
          // Announced rather than merely coloured: a reader who cannot see the disabled button
          // still hears why nothing happens.
          aria-describedby={`${fieldId}-state`}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            // The whole reason this dialog exists. Enter must never be the last thing between a
            // moving hand and a deleted account.
            if (event.key === 'Enter') event.preventDefault()
          }}
        />
        <span className="field__label" id={`${fieldId}-state`} role="status">
          {matched ? '入力が一致しました。' : '入力が一致するまで実行できません。'}
        </span>
      </div>
    </Dialog>
  )
}
