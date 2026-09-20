/**
 * The onboarding demo timeline — a single pure function of time.
 *
 * Everything the stage paints is derived here from one clock reading, so the
 * demo is deterministic (same t, same frame), scrubbable, restartable and
 * cleanup-safe: there are no scheduled side effects to leak, only `t`.
 *
 * Positions are expressed as *targets* — a named anchor ('stage', 'plot', a
 * toolbar control id, a floating card) plus fractional offsets — because pixel
 * positions depend on layout the timeline cannot know. A moving point is a
 * `{a, b, mix}` triple: resolve both endpoints to pixels (an element anchor
 * and a stage fraction can differ in kind) and interpolate — `DemoCursor` and
 * the file cards share that resolver, which is also how the cursor rides a
 * card: 'card1' resolves to the card's already-interpolated position.
 */

import type { SelectionRange } from '../graph/selection.ts'
import type { ChartViewport } from '../graph/UPlotChart.tsx'
import type { ViewMode } from '../graph/view-mode.ts'

/** A position: fractional offset inside a named anchor. */
export interface CursorTarget {
  /** 'stage' = the stage overlay itself; 'card1'/'card2' = a floating file card; else a DOM anchor id. */
  readonly anchor: string
  /** Fractional position inside the anchor (0..1). */
  readonly fx: number
  readonly fy: number
}

/** A point in motion between two targets — `mix` already eased. */
export interface Motion {
  readonly a: CursorTarget
  readonly b: CursorTarget
  readonly mix: number
}

export interface DemoFileCard extends Motion {
  readonly id: 'card1' | 'card2'
  readonly name: string
  readonly opacity: number
}

export interface DemoCaption {
  readonly title: string
  readonly body: string
}

/** All visual state of one frame of the demo. */
export interface DemoFrame {
  readonly t: number
  readonly datasetCount: 0 | 1 | 2
  readonly mode: ViewMode
  readonly viewport: ChartViewport
  readonly selection: SelectionRange | null
  readonly cursor: Motion & { readonly pressed: boolean; readonly visible: boolean }
  readonly cards: readonly DemoFileCard[]
  readonly dropzoneActive: boolean
  /** The graph-area drop affordance for the second file. */
  readonly dropHint: boolean
  /** 0..1 opacity of the column-detection card. */
  readonly mappingCardOpacity: number
  readonly pressedControl: 'gquality' | 'compare' | 'export' | null
  readonly exportNotice: boolean
  readonly caption: DemoCaption
  /** Which caption (for the progress dots), out of `captionCount`. */
  readonly captionIndex: number
  readonly captionCount: number
  /** 0..1 — fades in over the last stretch; the stage unmounts when the timeline ends. */
  readonly fadeOut: number
}

/* ---- Timeline marks (ms) ------------------------------------------------ */

const CARD1_IN = 500
const GRAB1 = 1000
const DROP1 = 2400
const MAP_IN = 2750
const MAP_OUT = 4700
const GRAPH_IN = 5000
const DRAW_END = 6600
const SEL_PRESS = 7100
const SEL_END = 8700
const SEL_HOLD_END = 9900
const GQ_PRESS = 11200
const GQ_PRESS_END = 11450
const GQ_ON = 11450
const CARD2_IN = 13100
const CARD2_DROP = 14500
const CMP_PRESS = 16100
const CMP_PRESS_END = 16350
const CMP_ON = 16350
const EXP_PRESS = 18600
const EXP_PRESS_END = 18850
const EXP_NOTICE = 19000
const END_CAPTION = 19900
const FADE_START = 20600

export const DEMO_DURATION_MS = 21200

const X_MAX = 1.45
const SEL_FROM = 0.34
const SEL_TO = 0.7

/* ---- Small timeline helpers --------------------------------------------- */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const ramp = (t: number, from: number, to: number): number => clamp01((t - from) / (to - from))
/** smoothstep — quiet easing, consistent with the instrument feel. */
const ease = (u: number): number => u * u * (3 - 2 * u)
const within = (t: number, from: number, to: number): boolean => t >= from && t < to
/** 0 before `at - fade`, ramps up to 1 at `at`, holds, fades out over `fade` after `until`. */
const pulse = (t: number, at: number, until: number, fade: number): number =>
  Math.min(ramp(t, at - fade, at), 1 - ramp(t, until, until + fade))

/* ---- Motion tracks -------------------------------------------------------- */

interface TrackKey {
  readonly at: number
  readonly target: CursorTarget
}

const stage = (fx: number, fy: number): CursorTarget => ({ anchor: 'stage', fx, fy })
const anchor = (id: string, fx = 0.5, fy = 0.5): CursorTarget => ({ anchor: id, fx, fy })

/** Evaluate a waypoint track at `t`: eased interpolation between the bracketing keys. */
function evalTrack(track: readonly TrackKey[], t: number): Motion {
  const first = track[0] as TrackKey
  if (t <= first.at) return { a: first.target, b: first.target, mix: 0 }
  for (let index = 1; index < track.length; index += 1) {
    const key = track[index] as TrackKey
    if (t <= key.at) {
      const prev = track[index - 1] as TrackKey
      return { a: prev.target, b: key.target, mix: ease(ramp(t, prev.at, key.at)) }
    }
  }
  const last = track[track.length - 1] as TrackKey
  return { a: last.target, b: last.target, mix: 0 }
}

/**
 * Cursor waypoints. Between two keys the position eases; when the anchors
 * differ the renderer resolves both to pixels and interpolates, which reads as
 * one continuous movement.
 */
const CURSOR_TRACK: readonly TrackKey[] = [
  { at: 0, target: stage(0.3, 0.16) },
  { at: 700, target: anchor('card1') },
  { at: DROP1, target: anchor('card1') },
  { at: 3300, target: stage(0.56, 0.3) },
  { at: 6600, target: anchor('plot', SEL_FROM / X_MAX, 0.55) },
  { at: SEL_END, target: anchor('plot', SEL_TO / X_MAX, 0.55) },
  { at: SEL_HOLD_END, target: anchor('plot', SEL_TO / X_MAX, 0.5) },
  { at: GQ_PRESS, target: anchor('gquality') },
  { at: 12900, target: anchor('gquality') },
  { at: CARD2_IN + 300, target: anchor('card2') },
  { at: CARD2_DROP, target: anchor('card2') },
  { at: 15400, target: stage(0.45, 0.5) },
  { at: CMP_PRESS, target: anchor('compare') },
  { at: 17900, target: anchor('compare') },
  { at: EXP_PRESS, target: anchor('export') },
  { at: END_CAPTION, target: stage(0.5, 0.84) },
  { at: DEMO_DURATION_MS, target: stage(0.5, 0.84) },
]

const PRESS_WINDOWS: readonly (readonly [number, number])[] = [
  [GRAB1, DROP1],
  [SEL_PRESS, SEL_END],
  [GQ_PRESS, GQ_PRESS_END],
  [CARD2_IN + 300, CARD2_DROP],
  [CMP_PRESS, CMP_PRESS_END],
  [EXP_PRESS, EXP_PRESS_END],
]

/* ---- File card tracks ----------------------------------------------------- */

const CARD1_TRACK: readonly TrackKey[] = [
  { at: CARD1_IN, target: stage(0.3, 0.14) },
  { at: DROP1, target: anchor('dropzone') },
]
const CARD2_TRACK: readonly TrackKey[] = [
  { at: CARD2_IN, target: stage(0.72, -0.06) },
  { at: CARD2_IN + 600, target: stage(0.72, 0.18) },
  { at: CARD2_DROP, target: anchor('plot', 0.5, 0.45) },
]

function cardsAt(t: number): readonly DemoFileCard[] {
  const cards: DemoFileCard[] = []
  const card1 = pulse(t, CARD1_IN, DROP1, 350)
  if (card1 > 0)
    cards.push({
      id: 'card1',
      name: 'normal_two_sensor_utf8.csv',
      ...evalTrack(CARD1_TRACK, t),
      opacity: card1,
    })
  const card2 = pulse(t, CARD2_IN, CARD2_DROP, 400)
  if (card2 > 0)
    cards.push({ id: 'card2', name: 'comparison_b.csv', ...evalTrack(CARD2_TRACK, t), opacity: card2 })
  return cards
}

/* ---- Captions ------------------------------------------------------------- */

const CAPTIONS: readonly (DemoCaption & { until: number })[] = [
  {
    until: MAP_OUT + 300,
    title: 'データを入れるだけ',
    body: '列は自動で検出し、曖昧な場合だけ確認します。',
  },
  {
    until: GQ_ON + 300,
    title: 'ドラッグで範囲を解析',
    body: '選んだ区間の統計が、その場で表示されます。',
  },
  {
    until: END_CAPTION,
    title: '解析から比較、書き出しまで',
    body: 'ひとつの画面で完結します。',
  },
  {
    until: DEMO_DURATION_MS,
    title: '準備は以上です',
    body: 'CSVをドロップして始めてください。操作はツールバーの「?」からいつでも確認できます。',
  },
]

/* ---- The frame ------------------------------------------------------------ */

function cursorAt(t: number): DemoFrame['cursor'] {
  const { a, b, mix } = evalTrack(CURSOR_TRACK, t)
  const pressed = PRESS_WINDOWS.some(([from, to]) => within(t, from, to))
  const visible = t >= 300 && t < FADE_START
  return { a, b, mix, pressed, visible }
}

function modeAt(t: number): ViewMode {
  if (t >= CMP_ON) return 'COMPARING'
  if (t >= GQ_ON) return 'G_QUALITY'
  return 'NORMAL'
}

/** The draw-in sweep: the x range grows 0 → full so the trace draws itself in. */
function viewportAt(t: number): ChartViewport {
  const sweep = ease(ramp(t, GRAPH_IN, DRAW_END))
  return { min: 0, max: 0.02 + (X_MAX - 0.02) * sweep }
}

function selectionAt(t: number): SelectionRange | null {
  if (t < SEL_PRESS) return null
  const reach = Math.max(ease(ramp(t, SEL_PRESS, SEL_END)), 0.04)
  return { xMin: SEL_FROM, xMax: SEL_FROM + (SEL_TO - SEL_FROM) * reach }
}

function pressedControlAt(t: number): DemoFrame['pressedControl'] {
  if (within(t, GQ_PRESS, GQ_PRESS_END)) return 'gquality'
  if (within(t, CMP_PRESS, CMP_PRESS_END)) return 'compare'
  if (within(t, EXP_PRESS, EXP_PRESS_END)) return 'export'
  return null
}

function captionAt(t: number): { caption: DemoCaption; index: number } {
  for (let index = 0; index < CAPTIONS.length; index += 1) {
    const entry = CAPTIONS[index] as DemoCaption & { until: number }
    if (t < entry.until) return { caption: entry, index }
  }
  const last = CAPTIONS[CAPTIONS.length - 1] as DemoCaption
  return { caption: last, index: CAPTIONS.length - 1 }
}

/** The whole stage at time `t`. Pure — safe to call at any rate, in any order. */
export function frameAt(t: number): DemoFrame {
  const cards = cardsAt(t)
  const { caption, index } = captionAt(t)
  return {
    t,
    datasetCount: t < DROP1 ? 0 : t < CARD2_DROP ? 1 : 2,
    mode: modeAt(t),
    viewport: viewportAt(t),
    selection: selectionAt(t),
    cursor: cursorAt(t),
    cards,
    dropzoneActive: within(t, DROP1 - 500, DROP1 + 250),
    dropHint: within(t, CARD2_IN + 500, CARD2_DROP),
    mappingCardOpacity: pulse(t, MAP_IN, MAP_OUT, 300),
    pressedControl: pressedControlAt(t),
    exportNotice: t >= EXP_NOTICE,
    caption,
    captionIndex: index,
    captionCount: CAPTIONS.length,
    fadeOut: ramp(t, FADE_START, DEMO_DURATION_MS),
  }
}

/**
 * The static frame for `prefers-reduced-motion`: the demo's *destination*
 * rather than its journey — both datasets loaded, comparison up, a selection
 * and the export notice already applied. Paired with the caption list it
 * conveys the same story without a moving cursor.
 */
export const STATIC_FRAME: DemoFrame = {
  t: DEMO_DURATION_MS,
  datasetCount: 2,
  mode: 'COMPARING',
  viewport: { min: 0, max: X_MAX },
  selection: { xMin: SEL_FROM, xMax: SEL_TO },
  cursor: { a: stage(0, 0), b: stage(0, 0), mix: 0, pressed: false, visible: false },
  cards: [],
  dropzoneActive: false,
  dropHint: false,
  mappingCardOpacity: 0,
  pressedControl: null,
  exportNotice: true,
  caption: CAPTIONS[CAPTIONS.length - 1] as DemoCaption,
  captionIndex: CAPTIONS.length - 1,
  captionCount: CAPTIONS.length,
  fadeOut: 0,
}

/** The story beats, listed for the reduced-motion summary. */
export const CAPTION_LIST: readonly DemoCaption[] = CAPTIONS.slice(0, -1)

/** Unique, stable keys for the caption progress dots (one per caption). */
export const CAPTION_TITLES: readonly string[] = CAPTIONS.map((entry) => entry.title)
