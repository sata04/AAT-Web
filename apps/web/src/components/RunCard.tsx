/**
 * One run in the gallery.
 *
 * The card carries two classes of information and treats them differently, because they cost
 * different things to obtain.
 *
 * **What the listing already knows** — run code, experiment date, suffix, original filename, memo,
 * tags — is drawn immediately, from the row `GET /api/v1/runs` returned. A card is never
 * blank and never a skeleton: even before anything else loads it identifies the experiment, which
 * is what a reader scanning for one of them actually needs.
 *
 * **What lives on other tables** — the revision history, the headline metrics, the G-quality
 * summary, whether a snapshot exists, whether a poster has been rendered — costs three requests,
 * so it is fetched when the card first becomes visible and not before. See `src/runs/facts.ts`.
 * Until it arrives those fields read 読み込み中; if it fails they read a message and offer a retry.
 * Neither state is allowed to hide the run.
 *
 * ## Status is text
 *
 * Every state on this card — snapshot present, poster ready, source backed up — is a word, not a
 * colour. The chips do carry a colour, but it is a second copy of what the word says, so the card
 * is fully readable in monochrome, at any contrast, and to a screen reader that reads the words and
 * knows nothing about the border.
 *
 * ## Everything is text, including the filename
 *
 * Run code, filename, memo and tags are rendered as text nodes. None of them is ever interpolated
 * into markup. A gallery is precisely where a hostile filename would be read by someone other than
 * whoever uploaded it.
 */

import { useEffect, useRef } from 'react'
import { formatFixed, formatSeconds } from '../app/format.ts'
import type { RunSummary } from '../cloud/gateway.ts'
import { Link } from '../router/Router.tsx'
import type { RunFactsState } from '../runs/facts.ts'
import {
  followsFilenameConvention,
  formatExperimentDate,
  formatMoment,
  suffixLabel,
} from '../runs/gallery.ts'
import { shortMemo } from '../runs/memo.ts'
import { summariseGQuality } from '../runs/metrics.ts'
import { RunPosterImage } from './RunPosterImage.tsx'

export interface RunCardProps {
  run: RunSummary
  facts: RunFactsState
  /**
   * Whose run this is, or null in the owner-scoped listing where every row is the reader's own.
   *
   * Rendered as a word, never as an avatar or an initial: the display name is the only human
   * identity AAT holds — the address on the user record is synthetic and non-routable — so there is
   * nothing to derive a picture from and nothing here that could be mistaken for a way to contact
   * somebody.
   */
  ownerDisplayName?: string | null
  /** Called once, when the card first enters the viewport. */
  onVisible: (runId: string) => void
  onRetryFacts: (runId: string) => void
}

/** A labelled status word. `tone` colours it; the word is what carries the meaning. */
function Chip(props: { label: string; value: string; tone: 'good' | 'bad' | 'busy' | 'muted' }) {
  return (
    <li className={`run-chip run-chip--${props.tone}`}>
      <span className="run-chip__label">{props.label}</span>
      <span className="run-chip__value">{props.value}</span>
    </li>
  )
}

function posterChip(facts: RunFactsState): { value: string; tone: 'good' | 'bad' | 'busy' | 'muted' } {
  if (facts.kind !== 'ready') return { value: '—', tone: 'muted' }
  const poster = facts.facts.autoPoster
  if (poster === null) return { value: '未生成', tone: 'muted' }
  switch (poster.status) {
    case 'ready':
      return { value: '生成済み', tone: 'good' }
    case 'failed':
      return { value: '失敗', tone: 'bad' }
    default:
      return { value: '生成中', tone: 'busy' }
  }
}

export function RunCard(props: RunCardProps): React.JSX.Element {
  const { run, facts, onVisible, onRetryFacts } = props
  const rootRef = useRef<HTMLLIElement | null>(null)
  const onVisibleRef = useRef(onVisible)
  onVisibleRef.current = onVisible

  /**
   * Ask for the expensive half when the card is actually on screen.
   *
   * `rootMargin` starts the load a little before the card scrolls into view, so a steady scroll
   * finds the numbers already there instead of watching them appear. The observer disconnects after
   * the first hit: the facts are requested once, and `BoundedFactLoader` would ignore a second
   * request anyway — this just avoids making it.
   *
   * A browser with no `IntersectionObserver` gets the eager behaviour rather than no behaviour: a
   * card that never loads its metrics because a capability was missing is a worse failure than a
   * few extra requests.
   */
  useEffect(() => {
    const element = rootRef.current
    if (element === null) return
    if (typeof IntersectionObserver !== 'function') {
      onVisibleRef.current(run.id)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        onVisibleRef.current(run.id)
      },
      { rootMargin: '200px 0px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [run.id])

  const ready = facts.kind === 'ready' ? facts.facts : null
  const metrics = ready?.metrics ?? null
  const gQuality = metrics === null ? null : summariseGQuality(metrics.gQuality)
  const latest = ready?.latest ?? null
  const memo = shortMemo(run.memo)
  const conventional = followsFilenameConvention(run)
  const poster = posterChip(facts)

  return (
    <li className="run-card" ref={rootRef}>
      <article className="run-card__inner" aria-labelledby={`run-${run.id}-code`}>
        <div className="run-card__figure">
          <RunPosterImage
            poster={ready?.autoPoster ?? null}
            runCode={run.runCode}
            size="thumbnail"
            // Never a blank box: before the facts arrive the slot says it is still loading, and
            // after them it says the figure does not exist. Those are different facts.
            absentLabel={facts.kind === 'ready' ? 'ポスター図なし' : '読み込み中'}
          />
        </div>

        <div className="run-card__body">
          <div className="run-card__head">
            {/* `h2`, not `h3`: `ScreenFrame` owns the `h1` and the gallery has no heading between
                them, so an `h3` here would be a skipped level in the document outline. */}
            <h2 className="run-card__code" id={`run-${run.id}-code`}>
              <Link to={`/runs/${encodeURIComponent(run.id)}`}>{run.runCode}</Link>
            </h2>
            <span className="run-card__date">{formatExperimentDate(run.experimentDate)}</span>
            <span className="panel__hint">枝番 {suffixLabel(run.suffix)}</span>
            {props.ownerDisplayName == null ? null : (
              <span className="run-card__owner">記録者 {props.ownerDisplayName}</span>
            )}
          </div>

          <p className="run-card__filename">
            <span className="run-card__filename-name">{run.originalFilename}</span>
            {conventional ? null : (
              <span className="run-card__flag" title="ファイル名が YYMMDD[a-z]_data.csv の規則に一致しません">
                命名規則外
              </span>
            )}
          </p>

          {memo === null ? null : <p className="run-card__memo">{memo}</p>}

          {run.tags.length === 0 ? null : (
            <ul className="run-card__tags" aria-label="タグ">
              {run.tags.map((tag) => (
                <li className="run-tag" key={tag}>
                  {tag}
                </li>
              ))}
            </ul>
          )}

          <div className="table-scroll">
            <table className="data-table run-card__metrics">
              <caption className="visually-hidden">{run.runCode} の最小標準偏差ウィンドウの統計</caption>
              <thead>
                <tr>
                  <th scope="col">センサー</th>
                  <th scope="col" className="numeric">
                    開始 (s)
                  </th>
                  <th scope="col" className="numeric">
                    平均 (G)
                  </th>
                  <th scope="col" className="numeric">
                    SD (G)
                  </th>
                  <th scope="col" className="numeric">
                    点数
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Inner Capsule</th>
                  <td className="numeric">{formatSeconds(metrics?.inner.startTime)}</td>
                  <td className="numeric">{formatFixed(metrics?.inner.mean, 6)}</td>
                  <td className="numeric">{formatFixed(metrics?.inner.std, 6)}</td>
                  <td className="numeric">{metrics?.innerSampleCount.toLocaleString('ja-JP') ?? '—'}</td>
                </tr>
                <tr>
                  <th scope="row">Drag Shield</th>
                  <td className="numeric">{formatSeconds(metrics?.drag.startTime)}</td>
                  <td className="numeric">{formatFixed(metrics?.drag.mean, 6)}</td>
                  <td className="numeric">{formatFixed(metrics?.drag.std, 6)}</td>
                  <td className="numeric">{metrics?.dragSampleCount.toLocaleString('ja-JP') ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="panel__hint run-card__gquality">
            {gQuality === null
              ? facts.kind === 'ready'
                ? 'G-quality: 未計算'
                : 'G-quality: —'
              : `G-quality: ${gQuality.windowCount} 窓 (${formatSeconds(gQuality.smallestWindow)}–${formatSeconds(gQuality.largestWindow)} s)` +
                (gQuality.bestInner === null
                  ? ''
                  : ` ・ IC 最小SD ${formatFixed(gQuality.bestInner.std, 6)} @ ${formatSeconds(gQuality.bestInner.windowSize)} s`) +
                (gQuality.bestDrag === null
                  ? ''
                  : ` ・ DS 最小SD ${formatFixed(gQuality.bestDrag.std, 6)} @ ${formatSeconds(gQuality.bestDrag.windowSize)} s`)}
          </p>

          <ul className="run-card__status" aria-label="保存状態">
            <Chip
              label="最新リビジョン"
              value={
                latest === null
                  ? facts.kind === 'ready'
                    ? '未解析'
                    : '読み込み中'
                  : `r${latest.revisionNumber} ・ ${formatMoment(latest.createdAt)} ・ engine ${latest.engineVersion}`
              }
              tone={latest === null ? 'muted' : 'good'}
            />
            <Chip
              label="スナップショット"
              value={
                latest === null
                  ? facts.kind === 'ready'
                    ? 'なし'
                    : '—'
                  : latest.hasSnapshot
                    ? 'あり'
                    : 'なし'
              }
              tone={latest?.hasSnapshot === true ? 'good' : 'muted'}
            />
            {/* No route answers "does this run have a source backup?" without downloading it and
                writing an audit entry, so the card says 未確認 rather than inventing a state. */}
            <Chip label="原本CSV" value="未確認" tone="muted" />
            <Chip label="ポスター" value={poster.value} tone={poster.tone} />
          </ul>

          {facts.kind === 'error' ? (
            <p className="run-card__facts-error" role="status">
              <span>詳細を読み込めませんでした。{facts.message}</span>
              <button type="button" className="button button--flat" onClick={() => onRetryFacts(run.id)}>
                再試行
              </button>
            </p>
          ) : null}
        </div>
      </article>
    </li>
  )
}
