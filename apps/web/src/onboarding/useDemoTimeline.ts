/**
 * Drives `frameAt(t)` with a requestAnimationFrame clock.
 *
 * The timeline itself is pure; this hook is only the clock. Accumulating frame
 * deltas rather than reading `performance.now()` outright means a hidden tab —
 * where rAF stops — pauses the demo instead of skipping it. `restart` is a
 * fresh clock, `skip`/`finished` hand control back to the caller, and the
 * effect's cleanup is the whole teardown: no timers, no listeners left behind.
 * StrictMode's double-mount exercises exactly that path and is safe.
 *
 * `prefers-reduced-motion` swaps the whole thing for {@link STATIC_FRAME}: no
 * clock, no moving cursor, the story told as a static summary instead.
 *
 * `restart` works even after the clock reaches the end: the raf loop is only
 * torn down by unmount, so rewinding `elapsedRef` is the whole reset.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DEMO_DURATION_MS, type DemoFrame, frameAt, STATIC_FRAME } from './demo-timeline.ts'

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listener = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [])
  return reduced
}

export interface DemoTimeline {
  readonly frame: DemoFrame
  readonly reducedMotion: boolean
  /** 0..1 — for the progress dots. */
  readonly progress: number
  readonly restart: () => void
  /** Stop and leave immediately — the same end state as letting it play out. */
  readonly skip: () => void
}

export function useDemoTimeline(onDone: () => void): DemoTimeline {
  const reducedMotion = usePrefersReducedMotion()
  const [t, setT] = useState(0)
  const elapsedRef = useRef(0)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const finishedRef = useRef(false)

  const finish = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    doneRef.current()
  }, [])

  useEffect(() => {
    if (reducedMotion) return
    let last: number | null = null
    let raf = 0
    const tick = (now: number) => {
      if (last !== null) elapsedRef.current += now - last
      last = now
      const elapsed = elapsedRef.current
      setT(Math.min(elapsed, DEMO_DURATION_MS))
      // The loop keeps running past the end so `restart` needs no re-arm —
      // `finish` fires once and unmounting cancels the raf.
      if (elapsed >= DEMO_DURATION_MS) finish()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reducedMotion, finish])

  const restart = useCallback(() => {
    elapsedRef.current = 0
    finishedRef.current = false
    setT(0)
  }, [])

  const frame = reducedMotion ? STATIC_FRAME : frameAt(t)
  return {
    frame,
    reducedMotion,
    progress: reducedMotion ? 1 : Math.min(t / DEMO_DURATION_MS, 1),
    restart,
    skip: finish,
  }
}
