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

/** An explicit `data-autofocus` wins over DOM order. */
function initialFocusTarget(panel: HTMLElement | null): HTMLElement | null {
  if (panel === null) return null
  return panel.querySelector<HTMLElement>('[data-autofocus]') ?? panel.querySelector<HTMLElement>(FOCUSABLE)
}

/**
 * The panel of every mounted dialog. Two dialogs can be open at once — a
 * modal raised while another was already up — and each hears the same
 * document keydown, because a second listener on one node is not stopped by
 * `stopPropagation`. So which dialog answers is decided here rather than by
 * the listeners' firing order: the topmost dialog is the one whose panel
 * comes last in document order, which is also the one painted above the rest.
 */
const openDialogPanels = new Set<HTMLElement>()

function topmostDialogPanel(): HTMLElement | null {
  let topmost: HTMLElement | null = null
  for (const panel of openDialogPanels) {
    const follows =
      topmost === null || (topmost.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    if (follows) topmost = panel
  }
  return topmost
}

export function Dialog(props: DialogProps): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<Element | null>(null)

  useEffect(() => {
    restoreFocusTo.current = document.activeElement
    initialFocusTarget(panelRef.current)?.focus()
    return () => {
      const previous = restoreFocusTo.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  // The backdrop covers the analyzer, drop targets included. A file dropped
  // anywhere while a dialog is up would otherwise reach the browser's default
  // handler, which navigates to the file and takes every open dataset with it —
  // a first-run user dragging a CSV onto the welcome would lose the session.
  // Cancelling the drop only works if `dragover` was cancelled first.
  useEffect(() => {
    const swallowFileDrag = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') === true) event.preventDefault()
    }
    document.addEventListener('dragover', swallowFileDrag)
    document.addEventListener('drop', swallowFileDrag)
    return () => {
      document.removeEventListener('dragover', swallowFileDrag)
      document.removeEventListener('drop', swallowFileDrag)
    }
  }, [])

  // Register for the topmost check the key handler consults. The panel
  // element is stable for the dialog's lifetime.
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    openDialogPanels.add(panel)
    return () => {
      openDialogPanels.delete(panel)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return
      // Every open dialog hears this keydown, but only the one painted on top
      // answers — one Escape must not close a second dialog behind it.
      const panel = panelRef.current
      if (panel === null || topmostDialogPanel() !== panel) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
        return
      }
      // Keep Tab inside the dialog: the content behind it is inert to the mouse
      // but not to the keyboard unless something holds the cycle closed.
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
    // The backdrop's pointer handler is a convenience duplicate of the Escape
    // key and the Cancel button, both of which are reachable from the keyboard,
    // so it needs no keyboard equivalent of its own.
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
