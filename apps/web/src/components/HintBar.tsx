/**
 * A contextual hint shown once inside the graph area.
 *
 * A bar, not a coach mark: it sits under the notices, leaves the whole plot
 * visible, is reachable in the normal tab order, and dismisses with Escape
 * while its controls are focused. `role="status"` announces it politely —
 * a hint is information about the interface, never an alarm.
 */

export interface HintBarProps {
  children: React.ReactNode
  onDismiss: () => void
}

export function HintBar(props: HintBarProps): React.JSX.Element {
  return (
    <div
      className="graph-hint"
      role="status"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          props.onDismiss()
        }
      }}
    >
      <div className="graph-hint__body">{props.children}</div>
      <button type="button" className="button button--flat" onClick={props.onDismiss}>
        分かりました
      </button>
    </div>
  )
}

/** A keyboard key rendered in hint copy, e.g. <Kbd>Shift</Kbd>. */
export function Kbd(props: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="kbd">{props.children}</kbd>
}
