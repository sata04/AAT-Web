/**
 * The first-run tour's stage — a modal layer over the live analyzer.
 *
 * This is not a slideshow and not a larger welcome dialog: the analyzer behind
 * the scrim is the real thing, and the scenes drive it — the sample CSVs go
 * through `openFiles`, the selection through `setSelection`, the mode flips
 * through the same transition table the toolbar uses. The stage only frames
 * what is already happening: a spotlight ring that follows the element a scene
 * is about, a live caption that says it in words, and a pseudo cursor that
 * points — never the sole carrier of information.
 *
 * The whole module loads lazily (`import()` in `AnalyzerScreen`), so returning
 * researchers — for whom the tour never mounts — never download it either.
 * Dialog behaviour is shared with `Dialog`: the stage registers in the same
 * topmost-panel set, so Escape and the Tab cycle reach it exactly like the
 * modals it replaces.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { initialFocusTarget, useTopmostDialogKeys } from '../components/Dialog.tsx'
import { csvFilesFrom } from '../components/FileDropZone.tsx'
import './onboarding.css'
import { DemoCursor } from './DemoCursor.tsx'
import type { TourDriver } from './tour-driver.ts'
import type { SceneDef } from './tour-scenes.ts'
import { type TourFinish, type TourMachine, useTour } from './use-tour.ts'

export interface OnboardingStageProps {
  readonly driver: TourDriver
  /**
   * 'keep' leaves whatever is open in place; 'skip' additionally removes the
   * demo datasets and restores the view — but only when the tour actually
   * drove, so dismissing a re-shown tour from its intro card leaves a
   * researcher's own workspace untouched.
   */
  readonly onFinish: (kind: TourFinish, drove: boolean) => void
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

const PHASES = [
  { id: 'data', label: 'データを読み込む' },
  { id: 'analyse', label: '解析する' },
  { id: 'try', label: '試してみる' },
] as const

/**
 * The spotlight ring's geometry, re-measured every frame: the element it
 * rings is real UI — the drop zone swaps for the chart mid-scene, the sidebar
 * reflows when a dataset lands — so the rect cannot be a one-time read.
 * Written straight to the element's style rather than through state: a
 * 60 fps setState would re-render the stage for a purely visual layer.
 */
const SPOT_PAD = 6

function spotKey(rect: DOMRect | null): string {
  if (rect === null) return 'none'
  return `${rect.left - SPOT_PAD},${rect.top - SPOT_PAD},${rect.width + SPOT_PAD * 2},${rect.height + SPOT_PAD * 2}`
}

function writeSpot(spot: HTMLElement, rect: DOMRect | null): void {
  spot.style.left = `${rect === null ? 0 : rect.left - SPOT_PAD}px`
  spot.style.top = `${rect === null ? 0 : rect.top - SPOT_PAD}px`
  spot.style.width = `${rect === null ? 0 : rect.width + SPOT_PAD * 2}px`
  spot.style.height = `${rect === null ? 0 : rect.height + SPOT_PAD * 2}px`
  spot.classList.toggle('onboarding-stage__spot--none', rect === null)
}

function useSpotlight(panelRef: React.RefObject<HTMLDivElement | null>, selector: string | null): void {
  useEffect(() => {
    const spot = panelRef.current?.querySelector<HTMLElement>('.onboarding-stage__spot')
    if (spot === undefined || spot === null) return
    let raf = 0
    let last = ''
    const track = () => {
      const target = selector === null ? null : document.querySelector(selector)
      const rect = target === null ? null : target.getBoundingClientRect()
      const key = spotKey(rect)
      if (key !== last) {
        writeSpot(spot, rect)
        last = key
      }
      raf = requestAnimationFrame(track)
    }
    raf = requestAnimationFrame(track)
    return () => cancelAnimationFrame(raf)
  }, [panelRef, selector])
}

function IntroCard({
  driver,
  onStart,
  onFinish,
}: {
  driver: TourDriver
  onStart: () => void
  onFinish: (kind: TourFinish) => void
}): React.JSX.Element {
  return (
    <div className="onboarding-card" role="document">
      <p className="onboarding-card__eyebrow">AAT Web</p>
      <p className="onboarding-card__lede">微小重力実験の加速度データを、ブラウザ上で解析します。</p>
      <ol className="welcome-steps">
        <li>CSVファイルを読み込む</li>
        <li>列の対応を確認する</li>
        <li>グラフと統計で解析する</li>
      </ol>
      <p className="panel__hint">
        解析はすべてこのブラウザ内で行われます。CSVファイルがクラウドへ送信されることはありません。
      </p>
      <div className="onboarding-card__actions">
        <button type="button" className="button button--primary" data-autofocus onClick={onStart}>
          デモを見る
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            // openDemo picks a non-colliding name, so a researcher's own
            // sample-a.csv is never overwritten by the demo.
            void driver.openDemo('a')
            onFinish('keep')
          }}
        >
          サンプルデータで試す
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            driver.openFilePicker()
            onFinish('keep')
          }}
        >
          CSVを開く
        </button>
        <button type="button" className="button button--flat" onClick={() => onFinish('skip')}>
          そのまま始める
        </button>
      </div>
    </div>
  )
}

function OutroCard({
  driver,
  onRestart,
  onFinish,
}: {
  driver: TourDriver
  onRestart: () => void
  onFinish: (kind: TourFinish) => void
}): React.JSX.Element {
  return (
    <div className="onboarding-card" role="document">
      <p className="onboarding-card__eyebrow">準備完了</p>
      <p className="onboarding-card__lede">サンプルデータを読み込みました。</p>
      <p className="panel__hint">
        このままグラフや統計を試せます。ご自身のCSVを開くと、いま見た流れがそのまま使えます。
      </p>
      <div className="onboarding-card__actions">
        <button
          type="button"
          className="button button--primary"
          data-autofocus
          onClick={() => onFinish('keep')}
        >
          このまま試す
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            driver.openFilePicker()
            onFinish('keep')
          }}
        >
          自分のCSVを開く
        </button>
        <button type="button" className="button button--flat" onClick={onRestart}>
          最初から見る
        </button>
      </div>
    </div>
  )
}

/**
 * The phase rail, live caption and transport — the chrome that stays put while
 * scenes change underneath it.
 */
function StageHud({
  scene,
  tour,
  reducedMotion,
  onFinish,
}: {
  scene: SceneDef
  tour: TourMachine
  reducedMotion: boolean
  onFinish: (kind: TourFinish) => void
}): React.JSX.Element {
  return (
    <div className="onboarding-stage__hud">
      <div className="onboarding-stage__rail" aria-hidden="true">
        {PHASES.map((phase) => (
          <span
            key={phase.id}
            className={
              phase.id === scene.phase
                ? 'onboarding-stage__phase onboarding-stage__phase--active'
                : 'onboarding-stage__phase'
            }
          >
            {phase.label}
          </span>
        ))}
      </div>
      <p className="onboarding-stage__caption" aria-live="polite" data-scene={scene.id}>
        {scene.caption}
        {reducedMotion ? (
          <span className="onboarding-stage__note">自動再生はオフです。「次へ」で一つずつ進めます。</span>
        ) : null}
      </p>
      <div className="onboarding-stage__controls">
        <button type="button" className="button button--flat" disabled={tour.index === 0} onClick={tour.back}>
          戻る
        </button>
        <span className="onboarding-stage__progress" aria-hidden="true">
          {tour.index + 1} / {tour.count}
        </span>
        <button
          type="button"
          className="button button--flat"
          disabled={tour.index === tour.count - 1}
          onClick={tour.next}
        >
          次へ
        </button>
        <button
          type="button"
          className="button button--flat"
          aria-pressed={tour.paused}
          // Pause only means something while autoplay is live — manual steps
          // run their own instant enter and the pinned cards keep no clock.
          disabled={!tour.playing || scene.pinned === true}
          onClick={tour.togglePause}
        >
          {tour.paused ? '再生' : '一時停止'}
        </button>
        <button type="button" className="button button--flat" onClick={tour.restart}>
          最初から
        </button>
        <button type="button" className="button" onClick={() => onFinish('skip')}>
          スキップ
        </button>
      </div>
    </div>
  )
}

export default function OnboardingStage(props: OnboardingStageProps): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const restoreFocusTo = useRef<Element | null>(null)
  const reducedMotion = useReducedMotion()
  // `drove` is whether any driving scene was ever entered — the difference
  // between closing the intro card (touched nothing) and skipping mid-tour
  // (demo datasets to remove, a view to restore).
  const droveRef = useRef(false)
  const finish = (kind: TourFinish) => props.onFinish(kind, droveRef.current)
  const tour = useTour({ driver: props.driver, reducedMotion, onFinish: finish })
  const scene = tour.scene
  if (tour.index > 0) droveRef.current = true

  useEffect(() => {
    restoreFocusTo.current = document.activeElement
    initialFocusTarget(panelRef.current)?.focus()
    return () => {
      const previous = restoreFocusTo.current
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useTopmostDialogKeys(panelRef, () => finish('skip'))
  useSpotlight(panelRef, scene.spotlight)

  // A commit can unmount the element holding focus — the intro card's
  // buttons leave with their scene — and the browser drops focus to the
  // body, from where the next Tab reaches the analyzer behind this modal.
  // Refocus the stage, but only when focus was inside it to begin with: an
  // idle pointer user's autoplay must not yank focus on every scene cut.
  // (No dep list: the check runs on every commit, not just scene changes.)
  const focusWasInsideRef = useRef(true)
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const active = document.activeElement
    const inside = active !== null && panel.contains(active)
    if (focusWasInsideRef.current && !inside) initialFocusTarget(panel)?.focus()
    // Read after the refocus: staying `inside` is what lets the next scene
    // change recapture again.
    focusWasInsideRef.current = panel.contains(document.activeElement)
  })

  // A file dropped on the scrim is a researcher answering the tour's first
  // question with their own data — open it for real and let them keep it.
  const onDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const files = csvFilesFrom(event.dataTransfer.files)
    if (files.length === 0) return
    void props.driver.openFiles(files)
    finish('keep')
  }

  return (
    <div
      className="onboarding-stage"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      ref={panelRef}
      onPointerDown={(event) => {
        // Clicks on bare scrim do nothing — the tour is only left through its
        // own controls — but the press must not hand focus to the page behind.
        if (event.target === event.currentTarget) event.preventDefault()
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDrop={onDrop}
    >
      <h2 id={titleId} className="visually-hidden">
        AAT Web のはじめてガイド
      </h2>

      <div className="onboarding-stage__spot" aria-hidden="true" />
      <DemoCursor cursor={tour.cursor} />

      {scene.id === 'intro' ? (
        <IntroCard driver={props.driver} onStart={tour.start} onFinish={finish} />
      ) : null}
      {scene.id === 'outro' ? (
        <OutroCard driver={props.driver} onRestart={tour.restart} onFinish={finish} />
      ) : null}

      <StageHud scene={scene} tour={tour} reducedMotion={reducedMotion} onFinish={finish} />
    </div>
  )
}
