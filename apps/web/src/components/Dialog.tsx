/**
 * A modal dialog.
 *
 * Small on purpose, and still does the three things a modal must do or it is
 * not a modal: it labels itself for assistive technology, it moves focus inside
 * on open and back on close, and Escape closes it. A dialog that swallows focus
 * is worse than no dialog — the desktop's Qt dialogs got all of this for free,
 * and the browser does not.
 */

import { useEffect, useId, useRef } from 'react'

export interface DialogProps {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
  /** Long explanatory text under the title. Newlines are preserved. */
  description?: string | undefined
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog(props: DialogProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<Element | null>(null)

  useEffect(() => {
    restoreFocusTo.current = document.activeElement
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
    return () => {
      const previous = restoreFocusTo.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
        return
      }
      if (event.key !== 'Tab') return
      // Keep Tab inside the dialog: the content behind it is inert to the mouse
      // but not to the keyboard unless something holds the cycle closed.
      const panel = panelRef.current
      if (panel === null) return
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [props])

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click is
    // a convenience duplicate of the Escape key and the Cancel button, both of
    // which are reachable from the keyboard.
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose()
      }}
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description === undefined ? undefined : descriptionId}
        ref={panelRef}
      >
        <h2 className="dialog__title" id={titleId}>
          {props.title}
        </h2>
        {props.description === undefined ? null : (
          <p className="dialog__description" id={descriptionId}>
            {props.description}
          </p>
        )}
        {props.children}
        <div className="dialog__actions">{props.footer}</div>
      </div>
    </div>
  )
}
