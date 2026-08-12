/**
 * The settings dialog.
 *
 * Covers the frozen configuration from `@aat/shared`, validated through the same
 * schema the rest of the system uses, so the dialog cannot accept a value the
 * engine would later reject. Changing anything that affects a number invalidates
 * the local cache automatically — the cache key is derived from `configHash`,
 * so there is no "clear cache after changing settings" step to forget.
 *
 * Desktop import is offered here rather than hidden in a menu: someone moving
 * from AAT 11 wants their `gravity_constant` and their window sizes, and
 * retyping them is exactly where a transcription error becomes a published
 * number. `migrateDesktopConfig` reports every field it had to reset, and those
 * reports are shown rather than swallowed.
 */

import type { AnalysisConfig } from '@aat/shared'
import { DEFAULT_ANALYSIS_CONFIG } from '@aat/shared'
import { useMemo, useState } from 'react'
import { importDesktopConfig, validateConfig } from '../app/settings.ts'
import { Dialog } from './Dialog.tsx'

export interface SettingsDialogProps {
  config: AnalysisConfig
  onCancel: () => void
  onApply: (config: AnalysisConfig) => void
  onClearCache: () => void
}

interface NumericFieldSpec {
  key: keyof AnalysisConfig
  label: string
  step: string
  hint?: string
}

/** Grouped the way the desktop's settings dialog groups them. */
const MEASUREMENT_FIELDS: NumericFieldSpec[] = [
  {
    key: 'sampling_rate',
    label: 'サンプリングレート (Hz)',
    step: '1',
    hint: '時間窓の長さの基準になります。',
  },
  { key: 'gravity_constant', label: '重力加速度 (m/s²)', step: '0.000001' },
  { key: 'acceleration_threshold', label: '同期点しきい値 (m/s²)', step: '0.1' },
  { key: 'end_gravity_level', label: '終了重力レベル (G)', step: '0.1' },
  { key: 'min_seconds_after_start', label: '終了判定の最小経過時間 (s)', step: '0.05' },
]

const ANALYSIS_FIELDS: NumericFieldSpec[] = [
  { key: 'window_size', label: '解析ウィンドウ (s)', step: '0.01' },
  { key: 'g_quality_start', label: 'G-quality 開始 (s)', step: '0.01' },
  { key: 'g_quality_end', label: 'G-quality 終了 (s)', step: '0.01' },
  { key: 'g_quality_step', label: 'G-quality 刻み (s)', step: '0.01' },
]

const DISPLAY_FIELDS: NumericFieldSpec[] = [
  { key: 'ylim_min', label: 'Y軸下限 (G)', step: '0.1' },
  { key: 'ylim_max', label: 'Y軸上限 (G)', step: '0.1' },
  { key: 'default_graph_duration', label: '既定の表示時間 (s)', step: '0.05' },
]

const EXPORT_FIELDS: NumericFieldSpec[] = [
  { key: 'export_figure_width', label: '書き出し幅 (inch)', step: '0.1' },
  { key: 'export_figure_height', label: '書き出し高さ (inch)', step: '0.1' },
  { key: 'export_dpi', label: '書き出しDPI', step: '10' },
]

export function SettingsDialog(props: SettingsDialogProps): React.JSX.Element {
  // Edits are kept as text so a half-typed "0." does not get coerced to 0 while
  // the user is still typing it.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => ({ ...props.config }))
  const [importReport, setImportReport] = useState<string[] | null>(null)

  const validation = useMemo(() => validateConfig(draft), [draft])
  const errors = validation.ok ? {} : validation.errors

  const setField = (key: keyof AnalysisConfig, value: unknown) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const numericField = (spec: NumericFieldSpec) => {
    const raw = draft[spec.key]
    const error = errors[spec.key as string]
    return (
      <label className="field" key={String(spec.key)}>
        <span className="field__label">{spec.label}</span>
        <input
          className="input input--numeric"
          type="number"
          step={spec.step}
          value={typeof raw === 'number' || typeof raw === 'string' ? String(raw) : ''}
          aria-invalid={error !== undefined}
          onChange={(event) => setField(spec.key, event.target.value)}
        />
        {spec.hint === undefined ? null : <span className="panel__hint">{spec.hint}</span>}
        {error === undefined ? null : <span className="field__error">{error}</span>}
      </label>
    )
  }

  const onImport = async (file: File) => {
    const result = importDesktopConfig(await file.text())
    setDraft({ ...result.config })
    const lines = [
      ...result.warnings.map((warning) => `${warning.key}: ${warning.message}`),
      ...(result.sourceAppVersion === null
        ? []
        : [`読み込んだ設定のアプリバージョン: ${result.sourceAppVersion}`]),
      ...(result.droppedKeys.length === 0
        ? []
        : [`Web版に対応する設定がないため無視した項目: ${result.droppedKeys.join(', ')}`]),
    ]
    setImportReport(lines.length === 0 ? ['すべての設定を読み込みました。'] : lines)
  }

  return (
    <Dialog
      title="設定"
      onClose={props.onCancel}
      footer={
        <>
          <button
            type="button"
            className="button button--flat"
            onClick={() => setDraft({ ...DEFAULT_ANALYSIS_CONFIG })}
          >
            既定値に戻す
          </button>
          <button type="button" className="button button--flat" onClick={props.onCancel}>
            キャンセル
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!validation.ok}
            onClick={() => {
              if (validation.ok) props.onApply(validation.config)
            }}
          >
            適用
          </button>
        </>
      }
    >
      <section className="dialog__section">
        <h3 className="panel__title">測定条件</h3>
        <div className="dialog__grid">{MEASUREMENT_FIELDS.map(numericField)}</div>
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">解析</h3>
        <div className="dialog__grid">{ANALYSIS_FIELDS.map(numericField)}</div>
        <div className="checkbox-row">
          <label htmlFor="auto-gq">読み込み時にG-qualityを自動計算する</label>
          <input
            id="auto-gq"
            type="checkbox"
            checked={draft.auto_calculate_g_quality === true}
            onChange={(event) => setField('auto_calculate_g_quality', event.target.checked)}
          />
        </div>
        <div className="checkbox-row">
          <label htmlFor="invert-inner">Inner Capsule の加速度を反転する</label>
          <input
            id="invert-inner"
            type="checkbox"
            checked={draft.invert_inner_acceleration === true}
            onChange={(event) => setField('invert_inner_acceleration', event.target.checked)}
          />
        </div>
        <div className="checkbox-row">
          <label htmlFor="use-cache">解析結果をブラウザにキャッシュする</label>
          <input
            id="use-cache"
            type="checkbox"
            checked={draft.use_cache === true}
            onChange={(event) => setField('use_cache', event.target.checked)}
          />
        </div>
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">表示</h3>
        <div className="dialog__grid">
          {DISPLAY_FIELDS.map(numericField)}
          <label className="field">
            <span className="field__label">表示するセンサー</span>
            <select
              className="select"
              value={String(draft.graph_sensor_mode ?? 'both')}
              onChange={(event) => setField('graph_sensor_mode', event.target.value)}
            >
              <option value="both">両方</option>
              <option value="inner_only">Inner Capsule のみ</option>
              <option value="drag_only">Drag Shield のみ</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">テーマ</span>
            <select
              className="select"
              value={String(draft.theme ?? 'system')}
              onChange={(event) => setField('theme', event.target.value)}
            >
              <option value="system">システムに合わせる</option>
              <option value="light">ライト</option>
              <option value="dark">ダーク</option>
            </select>
          </label>
        </div>
      </section>

      <section className="dialog__section">
        <h3 className="panel__title">書き出し</h3>
        <p className="panel__hint">
          幅・高さ・DPIはクラウドの正式ポスター（Matplotlib）に適用されます。ブラウザからのPNG保存はこれらの値を使いません。
        </p>
        <div className="dialog__grid">{EXPORT_FIELDS.map(numericField)}</div>
      </section>

      <hr className="separator" />

      <section className="dialog__section">
        <h3 className="panel__title">デスクトップ版の設定を読み込む</h3>
        <p className="panel__hint">
          AAT デスクトップ版の config.json を選択すると、対応する項目を移行します。
        </p>
        <input
          className="input"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) void onImport(file)
            event.target.value = ''
          }}
        />
        {importReport === null ? null : (
          <div className="notice notice--info">
            <div className="notice__body">
              <ul>
                {importReport.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>

      <hr className="separator" />

      <section className="dialog__section">
        <h3 className="panel__title">ローカルキャッシュ</h3>
        <p className="panel__hint">
          キャッシュは元のCSVから再計算できるため、削除しても解析結果は失われません。
        </p>
        <div>
          <button type="button" className="button" onClick={props.onClearCache}>
            キャッシュを削除
          </button>
        </div>
      </section>
    </Dialog>
  )
}
