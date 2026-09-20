/**
 * The tour's clock and state machine.
 *
 * A scene's work — opening the sample, drawing the selection sweep, holding a
 * view long enough to read — is driven by one clock built on
 * `requestAnimationFrame`, not on `setTimeout` piles: the whole timeline
 * freezes when the tab hides (rAF simply stops firing), a pause gate freezes
 * it on demand, and every wait is abort-aware so stepping, skipping and
 * unmounting all land on the same cleanup path. Manual stepping runs the same
 * `enter` as autoplay — the only difference is nothing advances afterwards.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TourDriver } from './tour-driver.ts'
import { cursorTargetFor, SCENES, type SceneDef, type TourCtx } from './tour-scenes.ts'

export type TourFinish = 'keep' | 'skip'

export interface TourCursorState {
  readonly visible: boolean
  readonly x: number
  readonly y: number
}

export interface TourMachine {
  readonly scene: SceneDef
  readonly index: number
  readonly count: number
  /** Autoplay is running (or held by pause). False once the user takes over. */
  readonly playing: boolean
  readonly paused: boolean
  readonly cursor: TourCursorState
  start(): void
  next(): void
  back(): void
  togglePause(): void
  restart(): void
  finish(kind: TourFinish): void
}

const ABORTED = new Error('tour scene aborted')

/**
 * Longest frame gap the clocks will ever accrue. Anything longer means the
 * tab was hidden or stalled — rAF stops while hidden but its timestamps do
 * not, so the resumed first frame would otherwise fast-forward the scene.
 */
const MAX_FRAME_MS = 100

function isAbort(error: unknown): boolean {
  return error === ABORTED
}

/**
 * Wait `ms` of *running* clock. When `gate()` is false the accumulator does
 * not advance — the deadline just stays ahead — which is what pausing and
 * background tabs both want. `instant` lands immediately.
 */
function clockWait(ms: number, signal: AbortSignal, gate: () => boolean, instant: boolean): Promise<void> {
  if (instant || ms <= 0) return signal.aborted ? Promise.reject(ABORTED) : Promise.resolve()
  return new Promise((resolve, reject) => {
    let accrued = 0
    let last = -1
    const step = (now: number) => {
      if (signal.aborted) return reject(ABORTED)
      // The first frame after a hidden tab resumes carries the whole hidden
      // span in `now - last`; clamping the delta freezes the timeline instead
      // of letting the tour fast-forward through it.
      if (last >= 0 && gate()) accrued += Math.min(now - last, MAX_FRAME_MS)
      last = now
      if (accrued >= ms) return resolve()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

/**
 * Drive `apply(t)` from 0 to 1 across `ms` of running clock — the primitive
 * the selection sweep and the zoom gesture are built from. Gated like
 * `clockWait`; `instant` applies the end state in one step.
 */
function clockTween(
  ms: number,
  apply: (t: number) => void,
  signal: AbortSignal,
  gate: () => boolean,
  instant: boolean,
): Promise<void> {
  if (instant || ms <= 0) {
    if (signal.aborted) return Promise.reject(ABORTED)
    apply(1)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let accrued = 0
    let last = -1
    const step = (now: number) => {
      if (signal.aborted) return reject(ABORTED)
      if (last >= 0 && gate()) accrued += Math.min(now - last, MAX_FRAME_MS)
      last = now
      if (accrued >= ms) {
        apply(1)
        return resolve()
      }
      apply(accrued / ms)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

/**
 * Poll the analyzer until `pred` holds — the tour's honest alternative to
 * timing a wait. Ungated on purpose: a real analysis cannot be paused, and a
 * hidden tab simply stops the clock (rAF never fires). Times out rather than
 * hang the tour on a pipeline failure.
 */
function clockWaitFor(pred: () => boolean, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (pred()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let elapsed = 0
    let last = -1
    const step = (now: number) => {
      if (signal.aborted) return resolve(false)
      if (pred()) return resolve(true)
      if (last >= 0) elapsed += now - last
      last = now
      if (elapsed >= timeoutMs) return resolve(false)
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

export function useTour(input: {
  driver: TourDriver
  reducedMotion: boolean
  onFinish: (kind: TourFinish) => void
}): TourMachine {
  const { driver, reducedMotion, onFinish } = input
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [paused, setPaused] = useState(false)
  const [cursor, setCursor] = useState<TourCursorState>({ visible: false, x: 0, y: 0 })

  const driverRef = useRef(driver)
  const playingRef = useRef(playing)
  const pausedRef = useRef(paused)
  const onFinishRef = useRef(onFinish)
  useEffect(() => {
    driverRef.current = driver
    playingRef.current = playing
    pausedRef.current = paused
    onFinishRef.current = onFinish
  })

  // Every activation lands on a different index — stepping is ±1 and restart
  // returns to 0 — so `index` alone re-fires the scene effect.
  const activate = useCallback((next: number) => {
    setIndex(Math.max(0, Math.min(next, SCENES.length - 1)))
  }, [])

  // The scene runner: entering a scene builds its world, then — only while
  // autoplay is live — holds it for the dwell and moves on. Aborting is the
  // single way out: manual steps, restart, skip and unmount all come through
  // the controller, so nothing written mid-scene can strand a half-applied
  // follow-up.
  useEffect(() => {
    const scene = SCENES[index] as SceneDef
    const controller = new AbortController()
    const { signal } = controller
    // The clock holds only while autoplay is up and unpaused. A manual step
    // keeps its animation — pausing a stepping user makes no sense — and a
    // hidden tab freezes everything regardless because rAF stops.
    const gate = () => !(playingRef.current && pausedRef.current)
    const instant = reducedMotion
    const ctx: TourCtx = {
      driver: driverRef.current,
      signal,
      instant,
      wait: (ms) => clockWait(ms, signal, gate, instant),
      waitFor: (pred, timeoutMs = 20_000) =>
        clockWaitFor(() => pred(driverRef.current.snapshot()), timeoutMs, signal),
      tween: (ms, apply) => clockTween(ms, apply, signal, gate, instant),
      cursor: {
        moveTo: (target) => {
          if (target === null) {
            setCursor((current) => (current.visible ? { ...current, visible: false } : current))
            return
          }
          const point =
            target instanceof Element
              ? (() => {
                  const rect = target.getBoundingClientRect()
                  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
                })()
              : target
          setCursor({ visible: true, x: point.x, y: point.y })
        },
        hide: () => setCursor((current) => (current.visible ? { ...current, visible: false } : current)),
      },
    }

    const run = async () => {
      ctx.cursor.moveTo(cursorTargetFor(scene.cursor))
      try {
        await scene.enter?.(ctx)
      } catch (error) {
        if (isAbort(error) || signal.aborted) return
        // A scene that fails must not hang the tour — report it and let the
        // dwell logic decide what comes next as usual.
        console.error('onboarding scene failed', error)
      }
      if (signal.aborted) return
      // The element a scene's cursor names may only exist once `enter` has
      // run — the statistics panel mounts with the first dataset, for one.
      ctx.cursor.moveTo(cursorTargetFor(scene.cursor))
      if (scene.pinned || !playingRef.current) return
      try {
        await ctx.wait(scene.dwellMs)
      } catch {
        return
      }
      if (signal.aborted || !playingRef.current) return
      activate(index + 1)
    }
    void run()
    return () => controller.abort()
  }, [index, reducedMotion, activate])

  const start = useCallback(() => {
    // Reduced motion never autoplays — the caption says so, so デモを見る
    // lands on the first scene and hands stepping to 次へ.
    setPlaying(!reducedMotion)
    setPaused(false)
    // `intro` is pinned, so autoplay begins at the first driving scene.
    activate(1)
  }, [activate, reducedMotion])

  const next = useCallback(() => {
    setPlaying(false)
    setPaused(false)
    activate(index + 1)
  }, [activate, index])

  const back = useCallback(() => {
    setPlaying(false)
    setPaused(false)
    activate(index - 1)
  }, [activate, index])

  const togglePause = useCallback(() => {
    setPaused((current) => !current)
  }, [])

  const restart = useCallback(() => {
    const current = driverRef.current
    current.closeTourDatasets()
    current.restoreBaseline()
    setPlaying(false)
    setPaused(false)
    setCursor({ visible: false, x: 0, y: 0 })
    activate(0)
  }, [activate])

  const finish = useCallback((kind: TourFinish) => {
    onFinishRef.current(kind)
  }, [])

  return {
    scene: SCENES[index] as SceneDef,
    index,
    count: SCENES.length,
    playing,
    paused,
    cursor,
    start,
    next,
    back,
    togglePause,
    restart,
    finish,
  }
}
