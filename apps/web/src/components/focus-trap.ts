/**
 * The keyboard half of "modal": the Tab cycle. Extracted from `Dialog.tsx`
 * so the shared file stays small — every focus rule lives here instead.
 */

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focus is outside a modal that is still up. */
function escapedDialog(panel: HTMLElement, active: Element | null): boolean {
  if (!(active instanceof Node)) return true
  return !panel.contains(active)
}

/** The control a wrapping Tab should land on, or null for a natural move. */
function wrapTarget(focusable: HTMLElement[], active: Element | null, shiftKey: boolean): HTMLElement | null {
  const first = focusable[0] as HTMLElement
  const last = focusable[focusable.length - 1] as HTMLElement
  // Single-control dialogs are first *and* last, and both checks run —
  // an early return would hide the other direction's wrap.
  if (shiftKey && active === first) return last
  if (!shiftKey && active === last) return first
  return null
}

// Keep Tab inside the dialog: the content behind it is inert to the mouse
// but not to the keyboard unless something holds the cycle closed.
export function keepTabInsideDialog(panel: HTMLElement, event: KeyboardEvent): void {
  const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const active = document.activeElement
  if (focusable.length === 0) {
    // A dialog with nothing tabbable — the tour's loading scrim is one —
    // still owns the keyboard: never let Tab walk into the page behind it.
    event.preventDefault()
    return
  }
  // Wrap at the edges; if focus already escaped the modal, pull it back to
  // the first control rather than letting Tab continue the inert page.
  const target =
    wrapTarget(focusable, active, event.shiftKey) ??
    (escapedDialog(panel, active) ? (focusable[0] as HTMLElement) : null)
  if (target === null) return
  event.preventDefault()
  target.focus()
}
