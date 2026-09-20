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
  type PosterFigureSizeOption,
  type PosterFormDefaults,
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
import { useMountedRef } from '../components/hooks.ts'
import type { SelectionRange } from '../graph/selection.ts'
import type { PosterRangeAction, PosterSpecAdvice } from './errors.ts'
import {
  type CustomPosterRequest,
  generateCustomPoster,
  type PosterContext,
  type PosterRequestOutcome,
} from './requests.ts'
import { defaultSeriesFor, posterSeriesOptionsFor } from './source.ts'

export interface PosterDialogProps {
  context: PosterContext
  /** The range selected on the graph, used to prefill the bounds. Null when nothing is selected. */
  selection: SelectionRange | null
  /**
   * The y-range the on-screen graph is drawn with — the analysis config's `ylim_min` / `ylim_max`.
   *
   * Prefilled rather than left blank so the poster starts out framed the way the graph the
   * researcher is looking at is framed, which is what the desktop application does: it draws the
   * screen axes and the export axes from the same two config values. Omitted, the frozen preset's
   * own `-1 .. 1` G is offered instead.
   */
  yRange?: { min: number; max: number }
  onClose: () => void
  /** Called for every figure that reaches `ready`, so the panel can keep the history. */
  onCreated: (poster: PosterFigure) => void
  /**
   * Called when a submit fails *after the dialog has closed* — the render
   * poll can outlive the dialog by minutes, and a failure then must land in
   * the notice stack rather than in a form nobody is looking at.
   */
  onFailed?: ((message: string) => void) | undefined
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

/** The four bound text fields a fresh dialog opens with. */
function initialBounds(
  selection: SelectionRange | null,
  yRange: { min: number; max: number } | undefined,
  defaults: PosterFormDefaults,
): Bounds {
  return {
    xMin: selection === null ? '' : String(selection.xMin),
    xMax: selection === null ? '' : String(selection.xMax),
    yMin: String(yRange?.min ?? defaults.yMin),
    yMax: String(yRange?.max ?? defaults.yMax),
  }
}

/** The form's values at submit time, in the units the request type wants. */
interface PosterFormValues {
  series: SeriesSelection
  title: string
  showLegend: boolean
  presetVersion: PosterPresetVersion
  /** Undefined when the stored size id fell off the option list — the preset's size then. */
  size: PosterFigureSizeOption | undefined
  dpi: number
  bounds: Bounds
}

/**
 * The request a submit sends, or null when the required x bounds cannot be
 * read — caught here rather than by the builder so the message can name the
 * two fields the user can see, instead of the spec field names they cannot.
 *
 * Optional bounds are assigned conditionally: the builder's request type is
 * exact, so "absent" and "present and undefined" are different requests. An
 * absent bound takes the frozen preset's `-1 .. 1` G — never Matplotlib's
 * autoscaling, which is a framing the desktop application cannot produce.
 */
function posterRequestFor(form: PosterFormValues, defaults: PosterFormDefaults): CustomPosterRequest | null {
  const xMin = numberOrNull(form.bounds.xMin)
  const xMax = numberOrNull(form.bounds.xMax)
  if (xMin === null || xMax === null) return null
  const yMin = numberOrNull(form.bounds.yMin)
  const yMax = numberOrNull(form.bounds.yMax)
  return {
    series: form.series,
    xMin,
    xMax,
    title: form.title,
    showLegend: form.showLegend,
    posterPresetVersion: form.presetVersion,
    figureWidth: form.size?.widthInches ?? defaults.figureWidth,
    figureHeight: form.size?.heightInches ?? defaults.figureHeight,
    dpi: form.dpi,
    ...(yMin === null ? {} : { yMin }),
    ...(yMax === null ? {} : { yMax }),
  }
}

/** Where a settled submit writes back. */
interface PosterOutcomeSinks {
  mounted: { readonly current: boolean }
  onCreated: (poster: PosterFigure) => void
  onFailed: ((message: string) => void) | undefined
  setSubmitting: (submitting: boolean) => void
  setCreated: (poster: PosterFigure | null) => void
  setAdvice: (advice: PosterSpecAdvice | null) => void
  setCloudMessage: (message: string | null) => void
}

/**
 * Route a submit's outcome. The dialog can be closed mid-render — the poll
 * continues regardless — so an outcome that lands after that goes to the
 * notice stack: nobody can see a form-level message, and the result still
 * belongs to the user.
 */
function settlePosterOutcome(outcome: PosterRequestOutcome, sinks: PosterOutcomeSinks): void {
  if (!sinks.mounted.current) {
    if (outcome.ok) sinks.onCreated(outcome.poster)
    else sinks.onFailed?.(outcome.kind === 'spec' ? outcome.advice.message : outcome.message)
    return
  }
  sinks.setSubmitting(false)
  if (outcome.ok) {
    sinks.setCreated(outcome.poster)
    sinks.onCreated(outcome.poster)
    return
  }
  if (outcome.kind === 'spec') {
    sinks.setAdvice(outcome.advice)
    return
  }
  sinks.setCloudMessage(outcome.message)
}

/** The bounds an advice action applies: narrow to the limit, or move to the data. */
function boundsAfterAdvice(action: PosterRangeAction, current: Bounds): Bounds {
  if (action.kind === 'narrow-range') {
    const start = numberOrNull(current.xMin) ?? 0
    return { ...current, xMax: String(start + action.maxSpanSeconds) }
  }
  return { ...current, xMin: String(action.xMin), xMax: String(action.xMax) }
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
  const [bounds, setBounds] = useState<Bounds>(() => initialBounds(selection, props.yRange, defaults))

  // The dialog can be closed mid-render; the poll continues regardless.
  const mounted = useMountedRef()

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

    const request = posterRequestFor(
      { series, title, showLegend, presetVersion, size, dpi, bounds },
      defaults,
    )
    if (request === null) {
      setCloudMessage('開始時刻と終了時刻を入力してください。')
      return
    }

    setSubmitting(true)
    const outcome = await generateCustomPoster(context, request)
    settlePosterOutcome(outcome, {
      mounted,
      onCreated: props.onCreated,
      onFailed: props.onFailed,
      setSubmitting,
      setCreated,
      setAdvice,
      setCloudMessage,
    })
  }

  const applyAdviceAction = () => {
    const action = advice?.action
    if (action === undefined || action === null) return
    setBounds((current) => boundsAfterAdvice(action, current))
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
      <RangeSection
        bounds={bounds}
        selection={selection}
        onBound={setBound}
        onImportSelection={(picked) =>
          setBounds((current) => ({ ...current, xMin: String(picked.xMin), xMax: String(picked.xMax) }))
        }
      />
      <YRangeSection bounds={bounds} defaults={defaults} onBound={setBound} />
      <ContentSection
        series={series}
        seriesOptions={seriesOptions}
        title={title}
        runCode={runCode}
        titlePreview={titlePreview}
        showLegend={showLegend}
        onSeries={setSeries}
        onTitle={setTitle}
        onShowLegend={setShowLegend}
      />
      <FormatSection
        presetVersion={presetVersion}
        figureSizeId={figureSizeId}
        dpi={dpi}
        sizeOptions={sizeOptions}
        dpiOptions={dpiOptions}
        onPresetVersion={setPresetVersion}
        onFigureSizeId={setFigureSizeId}
        onDpi={setDpi}
      />
      <PosterOutcome
        advice={advice}
        cloudMessage={cloudMessage}
        created={created}
        titlePreview={titlePreview}
        onApplyAdvice={applyAdviceAction}
      />
    </Dialog>
  )
}

/** The x-bounds fields, and the button that adopts the graph's selection. */
function RangeSection(props: {
  bounds: Bounds
  selection: SelectionRange | null
  onBound: (key: keyof Bounds, value: string) => void
  onImportSelection: (selection: SelectionRange) => void
}): React.JSX.Element {
  const { bounds, selection, onBound, onImportSelection } = props
  return (
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
            onChange={(event) => onBound('xMin', event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">終了 (s)</span>
          <input
            className="input input--numeric"
            type="number"
            step="0.001"
            value={bounds.xMax}
            onChange={(event) => onBound('xMax', event.target.value)}
          />
        </label>
      </div>
      {selection === null ? null : (
        <button type="button" className="button button--flat" onClick={() => onImportSelection(selection)}>
          グラフの選択範囲を取り込む
        </button>
      )}
    </section>
  )
}

/** The y-bounds fields; blank defers to the frozen preset's frame. */
function YRangeSection(props: {
  bounds: Bounds
  defaults: PosterFormDefaults
  onBound: (key: keyof Bounds, value: string) => void
}): React.JSX.Element {
  const { bounds, defaults, onBound } = props
  return (
    <section className="dialog__section">
      <h3 className="panel__title">Y軸の範囲 (G)</h3>
      <p className="panel__hint">
        初期値は画面のグラフと同じ範囲です。空欄にすると既定値（
        {defaults.yMin} 〜 {defaults.yMax} G）が使われます。デスクトップ版と同じく、
        データに合わせて自動で決まることはありません。
      </p>
      <div className="dialog__grid">
        <label className="field">
          <span className="field__label">下限 (G)</span>
          <input
            className="input input--numeric"
            type="number"
            step="0.001"
            value={bounds.yMin}
            onChange={(event) => onBound('yMin', event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">上限 (G)</span>
          <input
            className="input input--numeric"
            type="number"
            step="0.001"
            value={bounds.yMax}
            onChange={(event) => onBound('yMax', event.target.value)}
          />
        </label>
      </div>
    </section>
  )
}

/** What the figure shows: the sensors, the name, the legend. */
function ContentSection(props: {
  series: SeriesSelection
  seriesOptions: ReturnType<typeof posterSeriesOptionsFor>
  title: string
  runCode: string
  titlePreview: string
  showLegend: boolean
  onSeries: (series: SeriesSelection) => void
  onTitle: (title: string) => void
  onShowLegend: (show: boolean) => void
}): React.JSX.Element {
  return (
    <section className="dialog__section">
      <h3 className="panel__title">内容</h3>
      <div className="dialog__grid">
        <label className="field">
          <span className="field__label">表示するセンサー</span>
          <select
            className="select"
            value={props.series}
            onChange={(event) => props.onSeries(event.target.value as SeriesSelection)}
          >
            {props.seriesOptions.map((option) => (
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
            placeholder={props.runCode}
            value={props.title}
            onChange={(event) => props.onTitle(event.target.value)}
          />
          <span className="panel__hint">
            タイトルそのものではなく、タイトルと凡例に差し込まれる名前です。空欄ならラン番号（
            {props.runCode}）が使われます。
          </span>
        </label>
      </div>
      <p className="panel__hint">
        タイトル: {props.titlePreview}　/　凡例: {props.title === '' ? props.runCode : props.title} (Inner
        Capsule)
      </p>
      <div className="checkbox-row">
        <label htmlFor="poster-legend">凡例を表示する</label>
        <input
          id="poster-legend"
          type="checkbox"
          checked={props.showLegend}
          onChange={(event) => props.onShowLegend(event.target.checked)}
        />
      </div>
    </section>
  )
}

/** The frozen-preset's presentation knobs: preset version, size, resolution. */
function FormatSection(props: {
  presetVersion: PosterPresetVersion
  figureSizeId: PosterFigureSizeId
  dpi: number
  sizeOptions: readonly PosterFigureSizeOption[]
  dpiOptions: ReturnType<typeof posterDpiOptions>
  onPresetVersion: (version: PosterPresetVersion) => void
  onFigureSizeId: (id: PosterFigureSizeId) => void
  onDpi: (dpi: number) => void
}): React.JSX.Element {
  return (
    <section className="dialog__section">
      <h3 className="panel__title">体裁</h3>
      <div className="dialog__grid">
        <label className="field">
          <span className="field__label">プリセット</span>
          <select
            className="select"
            value={props.presetVersion}
            onChange={(event) => {
              const next = event.target.value
              props.onPresetVersion(isPosterPresetVersion(next) ? next : DEFAULT_POSTER_PRESET_VERSION)
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
            value={props.figureSizeId}
            onChange={(event) => props.onFigureSizeId(event.target.value as PosterFigureSizeId)}
          >
            {props.sizeOptions.map((option) => (
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
            value={String(props.dpi)}
            onChange={(event) => props.onDpi(Number(event.target.value))}
          >
            {props.dpiOptions.map((option) => (
              <option key={option.dpi} value={option.dpi}>
                {option.dpi} dpi — {option.label.ja}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  )
}

/** What a submit produced: advice, an error, or the finished figure. */
function PosterOutcome(props: {
  advice: PosterSpecAdvice | null
  cloudMessage: string | null
  created: PosterFigure | null
  titlePreview: string
  onApplyAdvice: () => void
}): React.JSX.Element {
  const { advice, cloudMessage, created, titlePreview, onApplyAdvice } = props
  return (
    <>
      {advice === null ? null : (
        <div className="notice notice--warning" role="status">
          <div className="notice__body">
            <p>{advice.message}</p>
            {advice.detail === null ? null : <p>{advice.detail}</p>}
            {advice.action === null ? null : (
              <button type="button" className="button" onClick={onApplyAdvice}>
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
    </>
  )
}
