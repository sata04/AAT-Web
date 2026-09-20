/**
 * A quiet inline explainer: a small `?` affordance that opens a short tooltip.
 *
 * Only for controls whose *names* do not carry their meaning (G-quality,
 * compare, …) — obvious buttons get nothing. Opens on hover and keyboard
 * focus, and stays open for a tap because the tap focuses the button.
 * Escape closes it without moving focus. The trigger's `aria-describedby`
 * always points at the bubble so screen readers get the description whether
 * or not the bubble is on screen.
 */

import { useId, useRef, useState } from 'react'

export interface InfoTipProps {
  /** What the tip explains — used to build the trigger's accessible name. */
  label: string
  /** One or two sentences. No markdown, no links. */
  text: string
  /**
   * Which edge of the trigger the bubble aligns to. `end` keeps the bubble on
   * screen for the right-hand toolbar cluster.
   */
  align?: 'start' | 'end' | undefined
}

export function InfoTip(props: InfoTipProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const bubbleId = useId()
  // Pointer hover and focus overlap on the same element; without a flag each
  // would fight the other's close.
  const hover = useRef(false)
  const focused = useRef(false)

  const reconcile = () => setOpen(hover.current || focused.current)

  return (
    <span className="info-tip" data-align={props.align ?? 'start'}>
      <button
        type="button"
        className="info-tip__button"
        aria-label={`${props.label}の説明`}
        aria-expanded={open}
        aria-describedby={bubbleId}
        onMouseEnter={() => {
          hover.current = true
          reconcile()
        }}
        onMouseLeave={() => {
          hover.current = false
          reconcile()
        }}
        onFocus={() => {
          focused.current = true
          reconcile()
        }}
        onBlur={() => {
          focused.current = false
          reconcile()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            hover.current = false
            focused.current = false
            setOpen(false)
          }
        }}
      >
        ?
      </button>
      <span
        id={bubbleId}
        role="tooltip"
        className={open ? 'info-tip__bubble' : 'info-tip__bubble info-tip__bubble--hidden'}
      >
        {props.text}
      </span>
    </span>
  )
}
