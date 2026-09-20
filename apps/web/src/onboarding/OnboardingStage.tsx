/**
 * The demo stage: a life-size, inert replica of the analyzer.
 *
 * The chrome (command bar, side panel, status bar) is hand-built markup
 * wearing the application's own classes, while the parts a viewer watches —
 * the chart, the selection band, the statistics tables — are the real
 * components fed by `buildDemoDatasets()` and the timeline.
 *
 * `inert` does triple duty here: nothing in the replica is focusable or
 * clickable, the subtree leaves the accessibility tree entirely (the captions
 * outside carry the meaning), and the scripted demo can never be interrupted
 * by a stray real click. Cursor targets register themselves into `anchors`
 * via callback refs, so the pseudo-cursor aims at real controls instead of
 * guessed coordinates.
 */

import { useMemo } from 'react'
import type { Dataset } from '../app/dataset.ts'
import { rangeStatisticsFor } from '../app/range-statistics.ts'
import { APP_VERSION } from '../app/version.ts'
import { RangeStatisticsPanel } from '../components/RangeStatisticsPanel.tsx'
import { StatisticsPanel } from '../components/StatisticsPanel.tsx'
import type { GraphPalette } from '../graph/theme.ts'
import { canSelectRange, isComparing, isGQuality, isShowingAll } from '../graph/view-mode.ts'
import { PosterPanel } from '../poster/PosterPanel.tsx'
import { DemoGraph } from './DemoGraph.tsx'
import type { DemoFrame } from './demo-timeline.ts'

/** `anchor('id')` → a callback ref registering/unregistering the element under `id`. */
export type AnchorRegistry = (id: string) => (element: HTMLElement | null) => void

const noop = (): void => {}

interface DemoToolbarProps {
  readonly frame: DemoFrame
  readonly anchor: AnchorRegistry
}

/** The analyzer's command bar, replicated with the same classes and labels. */
function DemoToolbar({ frame, anchor }: DemoToolbarProps): React.JSX.Element {
  const hasDatasets = frame.datasetCount > 0
  const comparing = isComparing(frame.mode)
  const showingAll = isShowingAll(frame.mode)
  const showingGQuality = isGQuality(frame.mode)
  const press = (id: NonNullable<DemoFrame['pressedControl']>): string =>
    frame.pressedControl === id ? ' onb-press' : ''

  return (
    <header className="command-bar">
      <div className="command-bar__brand">
        <span className="command-bar__title">AAT</span>
        <span className="command-bar__version">v{APP_VERSION}</span>
      </div>

      <div className="command-bar__tools command-bar__tools--primary">
        <div className="command-bar__group">
          <button type="button" className="button button--primary">
            ファイルを開く
          </button>
        </div>
        <div className="command-bar__group">
          <fieldset className="segmented">
            <legend className="visually-hidden">表示モード</legend>
            <button type="button" className="button" aria-pressed={!showingAll && !showingGQuality}>
              通常
            </button>
            <button type="button" className="button" aria-pressed={showingAll}>
              全データ
            </button>
            <button
              type="button"
              className={`button${press('gquality')}`}
              aria-pressed={showingGQuality}
              ref={anchor('gquality')}
            >
              G-quality
            </button>
          </fieldset>
        </div>
        <div className="command-bar__group">
          <button
            type="button"
            className={`button${press('compare')}`}
            aria-pressed={comparing}
            disabled={frame.datasetCount < 2 && !comparing}
            ref={anchor('compare')}
          >
            比較
          </button>
        </div>
        <div className="command-bar__group">
          <span className="command-bar__label">センサー</span>
          <select className="select" value="both" onChange={noop}>
            <option value="both">両方</option>
            <option value="inner_only">Inner Capsule のみ</option>
            <option value="drag_only">Drag Shield のみ</option>
          </select>
        </div>
        <div className="command-bar__group">
          <button type="button" className="button" disabled={!hasDatasets}>
            全体表示
          </button>
          <button type="button" className="button" disabled={!hasDatasets}>
            拡大
          </button>
          <button type="button" className="button" disabled={!hasDatasets}>
            縮小
          </button>
        </div>
      </div>

      <div className="command-bar__spacer" />

      <div className="command-bar__tools command-bar__tools--trailing">
        <div className="command-bar__group">
          <button
            type="button"
            className={`button button--flat${press('export')}`}
            disabled={!hasDatasets}
            ref={anchor('export')}
          >
            Excelで書き出す
          </button>
          <button type="button" className="button button--flat" disabled={!hasDatasets}>
            CSVで書き出す
          </button>
          <button type="button" className="button button--flat" disabled={!hasDatasets}>
            PNGを保存
          </button>
          <button type="button" className="button button--flat" aria-label="操作ガイド">
            ?
          </button>
          <button type="button" className="button button--flat">
            設定
          </button>
        </div>
      </div>
    </header>
  )
}

/** The empty-state drop zone, replicated — the real one is a functional input. */
function DemoDropZone({ active, anchor }: { active: boolean; anchor: AnchorRegistry }): React.JSX.Element {
  return (
    <div className="quickstart">
      <div className={active ? 'dropzone dropzone--active' : 'dropzone'} ref={anchor('dropzone')}>
        <span className="dropzone__title">CSVファイルをドロップ</span>
        <span>またはファイルを選択してください。複数選択でき、まとめて比較できます。</span>
        <ol className="quickstart__steps">
          <li>CSVを読み込む</li>
          <li>列の対応を確認</li>
          <li>グラフで解析</li>
        </ol>
        <span className="panel__hint">
          解析はブラウザ内で完結します。CSVファイルがアップロードされることはありません。
        </span>
        <span className="button button--primary">ファイルを選択</span>
      </div>
    </div>
  )
}

/** The column auto-detection card — the moment "was the mapping right?" answers itself. */
function MappingCard({ opacity }: { opacity: number }): React.JSX.Element {
  return (
    <div className="panel panel--framed onb-mapping" style={{ opacity }}>
      <div className="panel__header">
        <h2 className="panel__title">列を自動検出しました</h2>
      </div>
      <table className="data-table">
        <tbody>
          <tr>
            <th scope="row">時間列</th>
            <td>Time (s)</td>
          </tr>
          <tr>
            <th scope="row">Inner Capsule</th>
            <td>Z-axis acceleration 1(m/s2)</td>
          </tr>
          <tr>
            <th scope="row">Drag Shield</th>
            <td>Z-axis acceleration 2(m/s2)</td>
          </tr>
        </tbody>
      </table>
      <p className="panel__hint">曖昧な場合だけ、確認を求めます。</p>
    </div>
  )
}

function DatasetListPanel({ visible }: { visible: readonly Dataset[] }): React.JSX.Element {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2 className="panel__title">データセット</h2>
        <span className="panel__hint">{visible.length} 件</span>
      </div>
      <ul className="dataset-list">
        {visible.map((dataset, index) => (
          <li className="dataset-list__item" key={dataset.name}>
            <span className="button button--flat dataset-list__name" aria-current={index === 0}>
              {dataset.name}
            </span>
            <span className="button button--flat">閉じる</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FileInfoCard({ dataset }: { dataset: Dataset }): React.JSX.Element {
  return (
    <section className="panel">
      <div className="panel__header">
        <h2 className="panel__title">ファイル情報</h2>
      </div>
      <table className="data-table">
        <tbody>
          <tr>
            <th scope="row">文字コード</th>
            <td>{dataset.encoding}</td>
          </tr>
          <tr>
            <th scope="row">行数</th>
            <td className="numeric">{dataset.sampleCount.toLocaleString()}</td>
          </tr>
          <tr>
            <th scope="row">時間列</th>
            <td>{dataset.mapping.timeColumn}</td>
          </tr>
          <tr>
            <th scope="row">Inner Capsule</th>
            <td>{dataset.mapping.innerColumn}</td>
          </tr>
          <tr>
            <th scope="row">Drag Shield</th>
            <td>{dataset.mapping.dragColumn}</td>
          </tr>
        </tbody>
      </table>
    </section>
  )
}

export interface OnboardingStageProps {
  readonly frame: DemoFrame
  readonly datasets: readonly Dataset[]
  readonly palette: GraphPalette
  readonly anchor: AnchorRegistry
  /** Stable — publishes the uPlot event layer so it can be the 'plot' cursor anchor. */
  readonly onGestureLayer: (layer: HTMLElement | null) => void
}

export function OnboardingStage(props: OnboardingStageProps): React.JSX.Element {
  const { frame, datasets, palette, anchor, onGestureLayer } = props
  const visible = datasets.slice(0, frame.datasetCount)
  const active = visible[0] ?? null

  const statisticsDatasets = isComparing(frame.mode) ? visible : active === null ? [] : [active]
  // Real range statistics over the synthesized series — the numbers that
  // transition under the scripted drag are computed, not staged.
  const rangeResult = useMemo(
    () => (active === null || frame.selection === null ? null : rangeStatisticsFor(active, frame.selection)),
    [active, frame.selection],
  )

  return (
    <div className="app onb__app" inert aria-hidden="true">
      <DemoToolbar frame={frame} anchor={anchor} />
      <div className={frame.datasetCount === 0 ? 'workspace workspace--single' : 'workspace'}>
        <main className="graph-area">
          {frame.dropHint ? <div className="graph-area__drop-hint">CSVファイルをドロップして追加</div> : null}
          {frame.exportNotice ? (
            <div className="notice-stack">
              <div className="notice notice--info">
                <span className="notice__body">normal_two_sensor_utf8.xlsx を書き出しました。</span>
              </div>
            </div>
          ) : null}
          {frame.datasetCount === 0 ? (
            <DemoDropZone active={frame.dropzoneActive} anchor={anchor} />
          ) : (
            <DemoGraph frame={frame} datasets={datasets} palette={palette} onGestureLayer={onGestureLayer} />
          )}
          {frame.mappingCardOpacity > 0 ? <MappingCard opacity={frame.mappingCardOpacity} /> : null}
        </main>
        {frame.datasetCount === 0 ? null : (
          <aside className="side-panel">
            <DatasetListPanel visible={visible} />
            <StatisticsPanel datasets={statisticsDatasets} mode={frame.mode} />
            <RangeStatisticsPanel
              selection={frame.selection}
              result={rangeResult}
              enabled={canSelectRange(frame.mode)}
              onChange={noop}
            />
            <PosterPanel
              context={null}
              unavailableReason={null}
              status={{ kind: 'unavailable' }}
              selection={null}
              selectionEnabled={false}
              yRange={{ min: -1, max: 1 }}
              onRetryAuto={noop}
              customPosters={[]}
              onCustomCreated={noop}
            />
            {active === null ? null : <FileInfoCard dataset={active} />}
          </aside>
        )}
      </div>
      <footer className="status-bar">
        <span className="status-lane">
          <span
            className={`status-lane__dot ${frame.datasetCount === 0 ? 'status-lane__dot--neutral' : 'status-lane__dot--good'}`}
          />
          <span>解析</span>
          <span className="status-lane__value">{frame.datasetCount === 0 ? '待機中' : '完了'}</span>
        </span>
        <span className="status-lane">
          <span className="status-lane__dot status-lane__dot--neutral" />
          <span>クラウド同期</span>
          <span className="status-lane__value">ローカルのみ</span>
        </span>
        <span className="status-lane">
          <span className="status-lane__dot status-lane__dot--neutral" />
          <span>ポスター図</span>
          <span className="status-lane__value">未生成</span>
        </span>
      </footer>
    </div>
  )
}
