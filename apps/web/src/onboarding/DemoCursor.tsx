/**
 * The tour's pointer — a small arrow that glides between the controls a scene
 * is talking about, and sweeps with the selection edge while `select` plays.
 *
 * It is decoration with a job: it must never be the only place information
 * lives. The caption always says what is happening in words; the cursor just
 * shows where. It is `aria-hidden` and `pointer-events: none` for exactly that
 * reason, and under reduced motion it does not animate at all — it appears
 * where it should be, instantly.
 */

export function DemoCursor({
  cursor,
}: {
  cursor: { visible: boolean; x: number; y: number }
}): React.JSX.Element {
  return (
    <div
      className={cursor.visible ? 'onboarding-cursor' : 'onboarding-cursor onboarding-cursor--hidden'}
      style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      aria-hidden="true"
    >
      <svg className="onboarding-cursor__arrow" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
        <path d="M2 1 L18 9 L11 11 L9 18 Z" />
      </svg>
    </div>
  )
}
