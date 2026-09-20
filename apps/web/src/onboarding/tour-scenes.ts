/**
 * The tour's scene table — what each stop on the way through the analyzer
 * shows, says, and does to the real application underneath.
 *
 * Every `enter` is written to *establish* its scene's world, not assume it:
 * stepping backwards lands on a scene that re-opens, re-selects or re-frames
 * whatever later scenes tore down. The machine can therefore treat Back, Next,
 * replay and the opening autoplay as the exact same code path, and a scene
 * that arrives late or twice (restart, StrictMode) converges to the same
 * analyzer state instead of stacking effects.
 */

import { valueToPixel } from '../graph/geometry.ts'
import { isComparing } from '../graph/view-mode.ts'
import type { DemoDataset } from './demo-data.ts'
import type { TourDriver, TourSnapshot } from './tour-driver.ts'

export type SceneId =
  | 'intro'
  | 'ingest'
  | 'graph'
  | 'select'
  | 'stats'
  | 'gestures'
  | 'gquality'
  | 'compare'
  | 'export'
  | 'outro'

/** Where the demo cursor rests while a scene plays. */
export type CursorSpec =
  | { kind: 'none' }
  | { kind: 'selector'; selector: string }
  | { kind: 'button'; name: string }

export interface SceneDef {
  readonly id: SceneId
  /** The rail grouping this scene belongs to. */
  readonly phase: 'data' | 'analyse' | 'try'
  /** Announced by the live caption and painted under it. */
  readonly caption: string
  /**
   * Element the spotlight rings: a CSS selector resolved against the live
   * document every frame (the drop zone and the chart share `.graph-area`, so
   * the ring follows whichever is mounted). `null` dims the whole screen —
   * card scenes.
   */
  readonly spotlight: string | null
  /** Where the cursor glides to on entry; `none` parks it off-screen. */
  readonly cursor: CursorSpec
  /**
   * How long autoplay holds the scene once `enter` has finished. Pinned
   * scenes (the two cards) never leave on their own.
   */
  readonly dwellMs: number
  readonly pinned?: boolean
  /**
   * Establish this scene's analyzer state. Async because ingest and compare
   * really do open and analyse files — the tour waits on the same signals a
   * user would watch, not on a clock.
   */
  readonly enter?: (ctx: TourCtx) => Promise<void> | void
}

/** The pieces of the scene clock a scene's `enter` is allowed to use. */
export interface TourCtx {
  readonly driver: TourDriver
  readonly signal: AbortSignal
  /** Reduced motion or an explicit instant step: land on the end state at once. */
  readonly instant: boolean
  /** Hold for `ms` of *running* clock — a pause or a hidden tab freezes it. */
  wait(ms: number): Promise<void>
  /** Poll the analyzer until `pred` holds; resolves false on timeout. */
  waitFor(pred: (snapshot: TourSnapshot) => boolean, timeoutMs?: number): Promise<boolean>
  /** Drive `apply(t)` through `ms` of running clock; instant applies `1`. */
  tween(ms: number, apply: (t: number) => void): Promise<void>
  readonly cursor: {
    moveTo(target: Element | { x: number; y: number } | null): void
    hide(): void
  }
}

/**
 * Canonical baseline for a driving scene: only the listed demo roles open
 * (the tour never touches a researcher's own files — ownership is what the
 * driver tracked at install, never a matching filename), plain view, no
 * selection.
 */
function prepare(ctx: TourCtx, keep: readonly DemoDataset[]): void {
  ctx.driver.closeTourDatasets(keep)
  ctx.driver.setNormalMode()
  ctx.driver.setSelection(null)
  ctx.driver.setViewport(null)
  for (const which of keep) ctx.driver.activateDemo(which)
}

/** Screen point of a data x value, for the cursor sweep during `select`. */
function plotPoint(snapshot: TourSnapshot, x: number): { x: number; y: number } | null {
  const { geometry, gestureLayer } = snapshot
  if (geometry === null || gestureLayer === null) return null
  const over = gestureLayer.getBoundingClientRect()
  // `valueToPixel` answers relative to the chart root; `.u-over` starts at
  // `geometry.left`, so the offset inside the overlay is the difference.
  return { x: over.left + valueToPixel(geometry, x) - geometry.left, y: over.top + over.height * 0.45 }
}

async function enterIngest(ctx: TourCtx): Promise<void> {
  prepare(ctx, [])
  const filename = await ctx.driver.openDemo('a')
  if (ctx.signal.aborted) return
  await ctx.waitFor(
    (snapshot) =>
      snapshot.analysisReady && snapshot.datasets.some((dataset) => dataset.filename === filename),
  )
  if (ctx.signal.aborted) return
  ctx.driver.activateDemo('a')
}

function enterGraph(ctx: TourCtx): void {
  prepare(ctx, ['a'])
}

async function enterSelect(ctx: TourCtx): Promise<void> {
  prepare(ctx, ['a'])
  const range = ctx.driver.snapshot().dataRange
  if (range === null) return
  const span = range.max - range.min
  const xMin = range.min + span * 0.32
  const xMax = range.min + span * 0.58
  if (ctx.instant) {
    ctx.driver.setSelection({ xMin, xMax })
    return
  }
  await ctx.tween(1100, (t) => {
    const edge = xMin + (xMax - xMin) * t
    ctx.driver.setSelection({ xMin, xMax: edge })
    ctx.cursor.moveTo(plotPoint(ctx.driver.snapshot(), edge) ?? { x: -100, y: -100 })
  })
}

function enterStats(ctx: TourCtx): void {
  prepare(ctx, ['a'])
  const snapshot = ctx.driver.snapshot()
  if (snapshot.dataRange !== null) {
    const span = snapshot.dataRange.max - snapshot.dataRange.min
    ctx.driver.setSelection({
      xMin: snapshot.dataRange.min + span * 0.32,
      xMax: snapshot.dataRange.min + span * 0.58,
    })
  }
}

async function enterGestures(ctx: TourCtx): Promise<void> {
  prepare(ctx, ['a'])
  const range = ctx.driver.snapshot().dataRange
  if (range === null) return
  const span = range.max - range.min
  const zoomed = { min: range.min + span * 0.28, max: range.min + span * 0.66 }
  if (ctx.instant) {
    ctx.driver.setViewport(null)
    return
  }
  await ctx.tween(800, (t) => {
    const start = ctx.driver.snapshot().dataRange ?? range
    const full = { min: start.min, max: start.max }
    ctx.driver.setViewport({
      min: full.min + (zoomed.min - full.min) * t,
      max: full.max + (zoomed.max - full.max) * t,
    })
  })
  await ctx.wait(650)
  await ctx.tween(700, (t) => {
    ctx.driver.setViewport({
      min: zoomed.min + (range.min - zoomed.min) * t,
      max: zoomed.max + (range.max - zoomed.max) * t,
    })
  })
  ctx.driver.setViewport(null)
}

async function enterGQuality(ctx: TourCtx): Promise<void> {
  prepare(ctx, ['a'])
  ctx.driver.applyModeEvent('G_QUALITY_ON')
  await ctx.wait(1700)
  ctx.driver.applyModeEvent('G_QUALITY_OFF')
}

async function enterCompare(ctx: TourCtx): Promise<void> {
  prepare(ctx, ['a'])
  const filename = await ctx.driver.openDemo('b')
  if (ctx.signal.aborted) return
  const opened = await ctx.waitFor(
    (snapshot) =>
      snapshot.analysisReady && snapshot.datasets.some((dataset) => dataset.filename === filename),
  )
  if (!opened || ctx.signal.aborted) return
  ctx.driver.applyModeEvent('ENTER_COMPARING')
}

function enterExport(ctx: TourCtx): void {
  // Nothing to press: the scene points at the toolbar while the caption
  // explains it. Firing a real download mid-tour would be the opposite of
  // the quiet-tool promise. Stepping straight here from an early scene keeps
  // whichever view is up — compare only shows when there is data to compare.
  const snapshot = ctx.driver.snapshot()
  if (!isComparing(snapshot.mode) && snapshot.datasets.length >= 2) {
    ctx.driver.applyModeEvent('ENTER_COMPARING')
  }
}

export const SCENES: readonly SceneDef[] = [
  {
    id: 'intro',
    phase: 'data',
    caption: '実際の画面を少しだけ動かして概要を紹介します。いつでもスキップできます。',
    spotlight: null,
    cursor: { kind: 'none' },
    dwellMs: 0,
    pinned: true,
  },
  {
    id: 'ingest',
    phase: 'data',
    caption: 'CSVを読み込みます。解析はすべてこのブラウザ内で行われ、データは外部へ送信されません。',
    spotlight: '.graph-area',
    cursor: { kind: 'selector', selector: '#aat-file-open' },
    dwellMs: 800,
    enter: enterIngest,
  },
  {
    id: 'graph',
    phase: 'analyse',
    caption: '重力レベルの時系列が描かれます。内側がInner Capsule、外側がDrag Shieldです。',
    spotlight: '.graph-area',
    cursor: { kind: 'selector', selector: '.graph-area' },
    dwellMs: 2600,
    enter: enterGraph,
  },
  {
    id: 'select',
    phase: 'analyse',
    caption: 'グラフ上をドラッグすると、その区間を選択できます。',
    spotlight: '.graph-area',
    cursor: { kind: 'none' },
    dwellMs: 600,
    enter: enterSelect,
  },
  {
    id: 'stats',
    phase: 'analyse',
    caption: '選択した区間の統計がサイドバーにすぐ表示されます。',
    spotlight: 'section[aria-label="選択範囲の統計情報"]',
    cursor: { kind: 'selector', selector: 'section[aria-label="選択範囲の統計情報"]' },
    dwellMs: 2400,
    enter: enterStats,
  },
  {
    id: 'gestures',
    phase: 'analyse',
    caption: 'ホイールでズーム、Shift＋ドラッグでパン。「全体表示」で元に戻ります。',
    spotlight: '.graph-area',
    cursor: { kind: 'selector', selector: '.graph-area' },
    dwellMs: 400,
    enter: enterGestures,
  },
  {
    id: 'gquality',
    phase: 'analyse',
    caption: '「G-quality」で落下区間の重力品質を確認できます。',
    spotlight: '.graph-area',
    cursor: { kind: 'button', name: 'G-quality' },
    dwellMs: 400,
    enter: enterGQuality,
  },
  {
    id: 'compare',
    phase: 'analyse',
    caption: '2つ目のCSVを開くと、同じグラフに重ねて比較できます。',
    spotlight: '.graph-area',
    cursor: { kind: 'button', name: '比較' },
    dwellMs: 2200,
    enter: enterCompare,
  },
  {
    id: 'export',
    phase: 'analyse',
    caption: '結果はツールバーからExcel・CSV・PNGで書き出せます。',
    spotlight: '.command-bar',
    cursor: { kind: 'button', name: 'Excelで書き出す' },
    dwellMs: 2600,
    enter: enterExport,
  },
  {
    id: 'outro',
    phase: 'try',
    caption: 'サンプルデータを読み込みました。このまま操作を試せます。',
    spotlight: null,
    cursor: { kind: 'none' },
    dwellMs: 0,
    pinned: true,
  },
]

export const SCENE_INDEX: Readonly<Record<SceneId, number>> = Object.fromEntries(
  SCENES.map((scene, index) => [scene.id, index]),
) as Record<SceneId, number>

/** Resolve a cursor spec against the live document. */
export function cursorTargetFor(spec: CursorSpec): Element | null {
  if (spec.kind === 'selector') return document.querySelector(spec.selector)
  if (spec.kind === 'button') {
    for (const button of document.querySelectorAll('button')) {
      if (button.textContent?.trim() === spec.name) return button
    }
  }
  return null
}
