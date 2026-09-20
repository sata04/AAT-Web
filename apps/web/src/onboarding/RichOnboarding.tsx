/**
 * The first-run live onboarding — a scripted, life-size replay of the app
 * working, played on top of the real analyzer on first visit.
 *
 * A tour built from real components rather than a video: `frameAt(t)` is the
 * whole script, the stage renders the application's own chart/statistics/
 * selection machinery over synthesized-but-real data, and a pseudo-cursor
 * performs the gestures. Because it is state- rather than asset-driven it
 * themes with the app, survives offline, compresses losslessly to ~20 s, and
 * — under `prefers-reduced-motion` — collapses to a static summary instead of
 * a moving cursor.
 *
 * Prototype notes: mounted eagerly by `App.tsx` behind `?onboarding=demo`;
 * production would lazy-import this chunk and gate it on an onboarding flag.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadConfig } from '../app/settings.ts'
import { themeSettingFrom } from '../graph/theme.ts'
import { useThemePalette } from '../graph/use-theme-palette.ts'
import { DemoCursor, type ResolveContext, resolveMotion } from './DemoCursor.tsx'
import { buildDemoDatasets } from './demo-data.ts'
import { CAPTION_LIST, CAPTION_TITLES } from './demo-timeline.ts'
import './onboarding.css'
import { OnboardingStage } from './OnboardingStage.tsx'
import { useDemoTimeline } from './useDemoTimeline.ts'

export interface RichOnboardingProps {
  /** The demo finished or was skipped — unmount the stage. */
  readonly onDone: () => void
}

export function RichOnboarding(props: RichOnboardingProps): React.JSX.Element {
  const { frame, reducedMotion, progress, restart, skip } = useDemoTimeline(props.onDone)
  const datasets = useMemo(buildDemoDatasets, [])
  // The user's configured theme, not a guess — the replica must match the app
  // it is sitting on top of.
  const [theme] = useState(() => themeSettingFrom(loadConfig().theme))
  const { palette } = useThemePalette(theme)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const anchors = useRef(new Map<string, HTMLElement>())
  const anchor = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      if (element === null) anchors.current.delete(id)
      else anchors.current.set(id, element)
    },
    [],
  )
  const registerPlot = useCallback((layer: HTMLElement | null) => {
    if (layer === null) anchors.current.delete('plot')
    else anchors.current.set('plot', layer)
  }, [])

  // Focus lands on the skip control and returns when the stage closes — the
  // same contract `Dialog` keeps, since this overlay is modal in effect.
  const skipRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const previous = document.activeElement
    skipRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        skip()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [skip])

  const context: ResolveContext = {
    stageRect: stageRef.current?.getBoundingClientRect() ?? null,
    anchors: anchors.current,
    cards: frame.cards,
  }

  return (
    <div
      className="onb"
      role="dialog"
      aria-modal="true"
      aria-label="AAT Web の使い方デモ"
      ref={stageRef}
      style={{ opacity: 1 - frame.fadeOut }}
    >
      <OnboardingStage
        frame={frame}
        datasets={datasets}
        palette={palette}
        anchor={anchor}
        onGestureLayer={registerPlot}
      />

      {frame.cards.map((card) => {
        const position = resolveMotion(card, context)
        if (position === null) return null
        return (
          <div
            key={card.id}
            className="onb-filecard"
            style={{
              transform: `translate(${position.x}px, ${position.y}px) translate(-50%, -50%)`,
              opacity: card.opacity,
            }}
          >
            <svg className="onb-filecard__icon" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="1" y="1" width="12" height="12" rx="1.5" />
              <path d="M1 5.5h12M5.5 5.5V13" />
            </svg>
            {card.name}
          </div>
        )
      })}

      <DemoCursor cursor={frame.cursor} context={context} />

      <div className="onb__chrome">
        {reducedMotion ? (
          <div className="onb__summary">
            <ol className="onb__steps">
              {CAPTION_LIST.map((caption) => (
                <li key={caption.title}>
                  <strong>{caption.title}</strong>
                  <span>{caption.body}</span>
                </li>
              ))}
            </ol>
            <button type="button" className="button button--primary" ref={skipRef} onClick={skip}>
              閉じる
            </button>
          </div>
        ) : (
          <div className="onb__caption">
            <div className="onb__dots" aria-hidden="true">
              {CAPTION_TITLES.slice(0, frame.captionCount).map((title, index) => (
                <span
                  key={title}
                  className={index === frame.captionIndex ? 'onb__dot onb__dot--active' : 'onb__dot'}
                />
              ))}
            </div>
            <div className="onb__caption-text" role="status" key={frame.captionIndex}>
              <strong>{frame.caption.title}</strong>
              <span>{frame.caption.body}</span>
            </div>
            <div className="onb__caption-actions">
              <button type="button" className="button button--flat" onClick={restart}>
                最初から
              </button>
              <button
                type="button"
                className="button"
                ref={skipRef}
                onClick={skip}
                title="Esc キーでも閉じられます"
              >
                スキップ
              </button>
            </div>
          </div>
        )}
        <div className="onb__progress" aria-hidden="true">
          <div className="onb__progress-bar" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>
    </div>
  )
}
