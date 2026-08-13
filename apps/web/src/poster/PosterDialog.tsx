/**
 * The custom poster editor.
 *
 * A formal figure is not a screenshot, so this dialog is a review step rather than a menu command:
 * the researcher sees the exact range, the exact sensors, the exact title line and the exact
 * geometry before a container is asked to draw anything, and sees the result in the same place
 * afterwards. Rendering is charged against a quota and takes a cold container seconds to produce —
 * "press it and find out" is the wrong interaction for that.
 *
 * ## Every bounded choice comes from `@aat/plot-spec`
 *
 * The schema admits 2–20 inch figures at 72–600 dpi, which is the range a *validator* must allow:
 * it is defending a Python container against a hostile body, not designing a form. A form built on
 * those bounds would be two free numeric fields, and free numeric fields are how a researcher ends
 * up with a 3.1 × 19.7 inch figure at 583 dpi that does not sit next to last month's on the same
 * page. So the sizes, the resolutions, the sensor choices and every default are read from
 * `posterFigureSizeOptions` / `posterDpiOptions` / `POSTER_SERIES_OPTIONS` / `posterFormDefaults`,
 * which derive them from the frozen preset. Nothing here is restated, so nothing here can drift
 * from what the renderer draws.
 *
 * ## `title` is not the title
 *
 * This is the single most misreadable field in the spec, so the label says what it is and the hint
 * shows what will actually be drawn. The frozen contract renders the title as
 * `The Gravity Level <name>` and the legend entries as `<name> (Inner Capsule)` /
 * `<name> (Drag Shield)` — one name in three places — and this field replaces that *name*, never
 * the template. Empty means "use the run code", which is exactly what the desktop application does
 * with its CSV basename. `posterTitleLine` renders the preview from the preset's own template, so
 * the preview cannot disagree with the figure.
 *
 * ## Refusals are advice, never error text
 *
 * `buildPosterPlotSpec` refuses before it assembles a document. Those refusals arrive here through
 * `describePosterSpecError`, which turns a code plus its structured details into a Japanese
 * sentence and — for the two codes that carry enough to act on — a button that fixes the range.
 * A raw `Error.message` is never shown.
 */

import {
  DEFAULT_POSTER_PRESET_VERSION,
  findPosterFigureSize,
  isPosterPresetVersion,
  POSTER_PRESET_VERSIONS,
  type PosterFigureSizeId,
  type PosterPresetVersion,
  posterDpiOptions,
  posterFigureSizeOptions,
  posterFormDefaults,
  posterTitleLine,
  type SeriesSelection,
} from '@aat/plot-spec'
import { useMemo, useState } from 'react'
import { formatFixed } from '../app/format.ts'
import type { PosterFigure } from '../cloud/gateway.ts'
import { posterImageUrl } from '../cloud/gateway.ts'
import { Dialog } from '../components/Dialog.tsx'
import type { SelectionRange } from '../graph/selection.ts'
import type { PosterSpecAdvice } from './errors.ts'
import { type CustomPosterRequest, generateCustomPoster, type PosterContext } from './requests.ts'
import { defaultSeriesFor, posterSeriesOptionsFor } from './source.ts'

export interface PosterDialogProps {
  context: PosterContext
  /** The range selected on the graph, used to prefill the bounds. Null when nothing is selected. */
  selection: SelectionRange | null
  onClose: () => void
  /** Called for every figure that reaches `ready`, so the panel can keep the history. */
  onCreated: (poster: PosterFigure) => void
}

/** Text rather than numbers, so a half-typed `0.` is not coerced to `0` mid-keystroke. */
interface Bounds {
  xMin: string
  xMax: string
  yMin: string
  yMax: string
}

function numberOrNull(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

export function PosterDialog(props: PosterDialogProps): React.JSX.Element {
  const { context, selection } = props
  const { dataset, runCode } = context

  const defaults = useMemo(() => posterFormDefaults(), [])
  const [presetVersion, setPresetVersion] = useState<PosterPresetVersion>(defaults.posterPresetVersion)

  const sizeOptions = useMemo(() => posterFigureSizeOptions(presetVersion), [presetVersion])
  const dpiOptions = useMemo(() => posterDpiOptions(presetVersion), [presetVersion])
  const seriesOptions = useMemo(() => posterSeriesOptionsFor(dataset), [dataset])

  const [series, setSeries] = useState<SeriesSelection>(defaultSeriesFor(dataset) ?? defaults.series)
  const [title, setTitle] = useState(defaults.title)
  const [showLegend, setShowLegend] = useState(defaults.showLegend)
  const [figureSizeId, setFigureSizeId] = useState<PosterFigureSizeId>(defaults.figureSizeId)
  const [dpi, setDpi] = useState(defaults.dpi)

  // Prefilled from the selection, then owned by the form: a researcher typing exact bounds for a
  // method section must not have them snap back when the pointer grazes the graph behind the modal.
  const [bounds, setBounds] = useState<Bounds>(() => ({
    xMin: selection === null ? '' : String(selection.xMin),
    xMax: selection === null ? '' : String(selection.xMax),
    yMin: '',
    yMax: '',
  }))

  const [submitting, setSubmitting] = useState(false)
  const [advice, setAdvice] = useState<PosterSpecAdvice | null>(null)
  const [cloudMessage, setCloudMessage] = useState<string | null>(null)
  const [created, setCreated] = useState<PosterFigure | null>(null)

  const setBound = (key: keyof Bounds, value: string) => {
    setBounds((current) => ({ ...current, [key]: value }))
  }

  const size = findPosterFigureSize(figureSizeId, presetVersion) ?? sizeOptions[0]
  const titlePreview = posterTitleLine(runCode, title, presetVersion)

  const submit = async () => {
    setAdvice(null)
    setCloudMessage(null)
    setCreated(null)

    const xMin = numberOrNull(bounds.xMin)
    const xMax = numberOrNull(bounds.xMax)
    if (xMin === null || xMax === null) {
      // Caught here rather than by the builder so the message names the two fields the user can
      // see, instead of the spec field names they cannot.
      setCloudMessage('開始時刻と終了時刻を入力してください。')
      return
    }
    const yMin = numberOrNull(bounds.yMin)
    const yMax = numberOrNull(bounds.yMax)

    const request: CustomPosterRequest = {
      series,
      xMin,
      xMax,
      title,
      showLegend,
      posterPresetVersion: presetVersion,
      figureWidth: size?.widthInches ?? defaults.figureWidth,
      figureHeight: size?.heightInches ?? defaults.figureHeight,
      dpi,
      // Assigned conditionally: the builder's request type is exact, so "absent" and "present and
      // undefined" are different requests — and an absent y bound is what leaves Matplotlib's
      // autoscaling in charge, which is the preset's deliberate position.
      ...(yMin === null ? {} : { yMin }),
      ...(yMax === null ? {} : { yMax }),
    }

    setSubmitting(true)
    const outcome = await generateCustomPoster(context, request)
    setSubmitting(false)

    if (outcome.ok) {
      setCreated(outcome.poster)
      props.onCreated(outcome.poster)
      return
    }
    if (outcome.kind === 'spec') {
      setAdvice(outcome.advice)
      return
    }
    setCloudMessage(outcome.message)
  }

  const applyAdviceAction = () => {
    const action = advice?.action
    if (action === undefined || action === null) return
    if (action.kind === 'narrow-range') {
      const start = numberOrNull(bounds.xMin) ?? 0
      setBounds((current) => ({ ...current, xMax: String(start + action.maxSpanSeconds) }))
    } else {
      setBounds((current) => ({ ...current, xMin: String(action.xMin), xMax: String(action.xMax) }))
    }
    setAdvice(null)
  }

  return (
    <Dialog
      title="正式ポスター図を作成"
      description={
        'デスクトップ版と同じ体裁で、選択した範囲のポスター図を作成します。' +
        '画面上のグラフは表示用に間引かれていますが、ポスター図は解析結果の全データ点から描画されます。'
      }
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="button button--flat" onClick={props.onClose}>
            閉じる
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '作成中…' : '作成'}
          </button>
        </>
      }
    >
      <section className="dialog__section">
        <h3 className="panel__title">範囲</h3>
        <p className="panel__hint">
          {selection === null
            ? 'グラフ上をドラッグして範囲を選ぶと、ここに反映されます。数値を直接入力することもできます。'
            : `グラフの選択範囲: ${formatFixed(selection.xMin, 4)} 秒 ～ ${formatFixed(selection.xMax, 4)} 秒`}
        </p>
        <div className="dialog__grid">
          <label className="field">
            <span className="field__label">開始 (s)</span>
            <input
              className="input input--numeric"
              type="number"
              step="0.001"
              value={bounds.xMin}
              onChange={(event) => setBound('xMin', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">終了 (s)</span>
            <input
              className="input input--numeric"
              type="number"
              step="0.001"
              value={bounds.xMax}
              onChange={(event) => setBound('xMax', event.target.value)}
            />
          </label>
        </div>
        {selection === null ? null : (
          <button
            type="button"
            className="button button--flat"
            onClick={() =>
              setBounds((current) => ({
                ...current,
                xMin: String(selection.xMin),
                xMax: String(selection.xMax),
              }))
            }
          >
            グラフの選択範囲を取り込む
          </button>
        )}
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">Y軸の範囲（任意）</h3>
        <p className="panel__hint">空欄のままにすると、デスクトップ版と同じく自動で目盛りが決まります。</p>
        <div className="dialog__grid">
          <label className="field">
            <span className="field__label">下限 (G)</span>
            <input
              className="input input--numeric"
              type="number"
              step="0.001"
              value={bounds.yMin}
              onChange={(event) => setBound('yMin', event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">上限 (G)</span>
            <input
              className="input input--numeric"
              type="number"
              step="0.001"
              value={bounds.yMax}
              onChange={(event) => setBound('yMax', event.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">内容</h3>
        <div className="dialog__grid">
          <label className="field">
            <span className="field__label">表示するセンサー</span>
            <select
              className="select"
              value={series}
              onChange={(event) => setSeries(event.target.value as SeriesSelection)}
            >
              {seriesOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label.ja}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">図の名前</span>
            <input
              className="input"
              type="text"
              maxLength={120}
              placeholder={runCode}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <span className="panel__hint">
              タイトルそのものではなく、タイトルと凡例に差し込まれる名前です。空欄ならラン番号（
              {runCode}）が使われます。
            </span>
          </label>
        </div>
        <p className="panel__hint">
          タイトル: {titlePreview}　/　凡例: {title === '' ? runCode : title} (Inner Capsule)
        </p>
        <div className="checkbox-row">
          <label htmlFor="poster-legend">凡例を表示する</label>
          <input
            id="poster-legend"
            type="checkbox"
            checked={showLegend}
            onChange={(event) => setShowLegend(event.target.checked)}
          />
        </div>
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">体裁</h3>
        <div className="dialog__grid">
          <label className="field">
            <span className="field__label">プリセット</span>
            <select
              className="select"
              value={presetVersion}
              onChange={(event) => {
                const next = event.target.value
                setPresetVersion(isPosterPresetVersion(next) ? next : DEFAULT_POSTER_PRESET_VERSION)
              }}
            >
              {POSTER_PRESET_VERSIONS.map((version) => (
                <option key={version} value={version}>
                  {version}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">図のサイズ</span>
            <select
              className="select"
              value={figureSizeId}
              onChange={(event) => setFigureSizeId(event.target.value as PosterFigureSizeId)}
            >
              {sizeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label.ja} — {option.widthInches} × {option.heightInches} in
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">解像度</span>
            <select
              className="select"
              value={String(dpi)}
              onChange={(event) => setDpi(Number(event.target.value))}
            >
              {dpiOptions.map((option) => (
                <option key={option.dpi} value={option.dpi}>
                  {option.dpi} dpi — {option.label.ja}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {advice === null ? null : (
        <div className="notice notice--warning" role="status">
          <div className="notice__body">
            <p>{advice.message}</p>
            {advice.detail === null ? null : <p>{advice.detail}</p>}
            {advice.action === null ? null : (
              <button type="button" className="button" onClick={applyAdviceAction}>
                {advice.action.label}
              </button>
            )}
          </div>
        </div>
      )}

      {cloudMessage === null ? null : (
        <div className="notice notice--error" role="status">
          <span className="notice__body">{cloudMessage}</span>
        </div>
      )}

      {created === null ? null : (
        <section className="dialog__section">
          <h3 className="panel__title">作成したポスター図</h3>
          <p className="panel__hint">
            この図は履歴として残ります。設定を変えて作成すると、上書きではなく別の図として追加されます。
          </p>
          <img
            src={posterImageUrl(created.posterId)}
            alt={`${titlePreview} のポスター図`}
            style={{ maxWidth: '100%', height: 'auto', background: '#ffffff' }}
          />
          <p className="panel__hint">
            <a href={posterImageUrl(created.posterId)} target="_blank" rel="noreferrer">
              元のサイズで開く
            </a>
          </p>
        </section>
      )}
    </Dialog>
  )
}
