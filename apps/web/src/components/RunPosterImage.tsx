/**
 * A rendered poster figure, or an honest statement of why there is no picture.
 *
 * The component never asks for a render. `posterImageUrl` points at
 * `GET /api/v1/posters/:posterId/image`, which streams a PNG that already exists and refuses with
 * `RESOURCE_NOT_FOUND` for a figure that is not `ready`. Every path that *starts* a render is a
 * POST in `src/runs/api.ts`, wired to a button — so no amount of scrolling, re-rendering or
 * re-mounting this component can cost container time.
 *
 * The four lifecycle states are shown as sentences rather than as an empty box: `queued` and
 * `rendering` are transient and worth waiting for, `failed` is worth retrying, and no figure at all
 * is worth generating. A blank rectangle says none of that.
 *
 * `alt` names the run, because that is what the picture is *of*. An alt of "ポスター図" would tell a
 * screen-reader user which kind of image it is and nothing about which measurement, which on a
 * gallery of twenty cards is no information at all.
 */

import { type PosterFigure, posterImageUrl } from '../cloud/gateway.ts'

export interface RunPosterImageProps {
  poster: PosterFigure | null
  /** Names the figure for assistive technology and in the failure text. */
  runCode: string
  /** `thumbnail` is the gallery's wide strip; `full` is the detail screen's readable figure. */
  size: 'thumbnail' | 'full'
  /** Shown when `poster` is null, so a card and a detail panel can phrase it differently. */
  absentLabel?: string | undefined
}

function statusLabel(poster: PosterFigure): string {
  switch (poster.status) {
    case 'queued':
      return 'ポスター生成の待機中です。'
    case 'rendering':
      return 'ポスターを生成しています…'
    case 'failed':
      return poster.failureCode === null
        ? 'ポスターの生成に失敗しました。'
        : `ポスターの生成に失敗しました (${poster.failureCode})。`
    case 'ready':
      return ''
  }
}

export function RunPosterImage(props: RunPosterImageProps): React.JSX.Element {
  const { poster, runCode, size } = props
  const className = size === 'thumbnail' ? 'run-poster run-poster--thumb' : 'run-poster run-poster--full'

  if (poster === null) {
    return (
      <p className={`${className} run-poster--empty`}>
        {props.absentLabel ?? 'ポスター図はまだありません。'}
      </p>
    )
  }

  if (poster.status !== 'ready') {
    return (
      <p className={`${className} run-poster--empty`} role="status">
        {statusLabel(poster)}
      </p>
    )
  }

  const kindLabel = poster.kind === 'auto' ? '自動ポスター図' : 'カスタムポスター図'
  return (
    <img
      className={className}
      src={posterImageUrl(poster.posterId)}
      // Native lazy loading, so a card that is never scrolled to never fetches its PNG. The
      // Worker checks ownership on every one of these, so a request that is not made is also an
      // authorization check that is not made.
      loading="lazy"
      decoding="async"
      alt={`${runCode} の${kindLabel}`}
    />
  )
}
