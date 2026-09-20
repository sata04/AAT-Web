/**
 * The pseudo-cursor, and the shared position resolver.
 *
 * The cursor is decorative: `aria-hidden`, pointer-events none, and every beat
 * it "performs" is also written in the caption text so nothing is lost without
 * it. What makes it convincing is that it targets *real things* — toolbar
 * buttons, the drop zone, the uPlot event layer — resolved to pixels against
 * the live layout each frame, rather than a fixed coordinate list that would
 * drift the moment the window resizes.
 *
 * `resolveMotion`/`resolveTarget` live here because the cursor and the file
 * cards share them: a card is the same `{a, b, mix}` motion the cursor is, and
 * the 'card1'/'card2' anchor resolves to the card's already-evaluated
 * position, which is what lets the cursor ride a dragged file.
 */

import type { CursorTarget, DemoFileCard, Motion } from './demo-timeline.ts'

export interface ResolveContext {
  /** The stage overlay's rect — target-space origin for every position. */
  readonly stageRect: DOMRect | null
  /** Element anchors registered by the stage ('plot', 'dropzone', controls…). */
  readonly anchors: ReadonlyMap<string, HTMLElement>
  readonly cards: readonly DemoFileCard[]
}

/**
 * Resolve a fractional motion to stage-relative pixels.
 * A single unresolved endpoint falls back to the resolved one — the cursor
 * waits at the last good position while an anchor mounts rather than blinking
 * out mid-demo. Null only when neither endpoint resolves (e.g. first paint).
 */
export function resolveMotion(motion: Motion, context: ResolveContext): { x: number; y: number } | null {
  const a = resolveTarget(motion.a, context)
  const b = resolveTarget(motion.b, context)
  if (a === null) return b
  if (b === null) return a
  return { x: a.x + (b.x - a.x) * motion.mix, y: a.y + (b.y - a.y) * motion.mix }
}

function resolveTarget(target: CursorTarget, context: ResolveContext): { x: number; y: number } | null {
  const { stageRect } = context
  if (stageRect === null) return null
  if (target.anchor === 'stage') {
    return { x: target.fx * stageRect.width, y: target.fy * stageRect.height }
  }
  if (target.anchor === 'card1' || target.anchor === 'card2') {
    const card = context.cards.find((entry) => entry.id === target.anchor)
    return card === undefined ? null : resolveMotion(card, context)
  }
  const element = context.anchors.get(target.anchor)
  if (element === undefined) return null
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left - stageRect.left + target.fx * rect.width,
    y: rect.top - stageRect.top + target.fy * rect.height,
  }
}

export interface DemoCursorProps {
  readonly cursor: Motion & { readonly pressed: boolean; readonly visible: boolean }
  readonly context: ResolveContext
}

export function DemoCursor(props: DemoCursorProps): React.JSX.Element | null {
  const position = resolveMotion(props.cursor, props.context)
  if (!props.cursor.visible || position === null) return null
  return (
    <div
      className={props.cursor.pressed ? 'onb-cursor onb-cursor--pressed' : 'onb-cursor'}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      aria-hidden="true"
    >
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative pseudo-cursor — the captions carry meaning; the whole stage is aria-hidden. */}
      <svg className="onb-cursor__arrow" width="18" height="18" viewBox="0 0 18 18">
        <path d="M2 1.5 L2 13.5 L5.6 10.6 L7.6 15.4 L9.9 14.4 L7.9 9.7 L12.5 9.4 Z" />
      </svg>
      {props.cursor.pressed ? <span className="onb-cursor__ring" /> : null}
    </div>
  )
}
