/**
 * One run: what it is, what was done to it, and how to reopen it.
 *
 * The screen is arranged as an answer to four questions in the order a researcher asks them —
 * *which experiment is this*, *what do I know about it*, *what analyses exist*, and *can I get the
 * data back* — and the last one is the one this application is judged on. A cloud record whose only
 * affordance is looking at a stored picture would have quietly turned a reproducibility feature
 * into a screenshot album. So the snapshot is opened into the analyzer's own dataset type and
 * handed to `RunReplayPanel`, which draws it, selects over it, measures it, exports it and posters
 * it with the analyzer's own code. See `src/runs/replay.ts`.
 *
 * ## What each state is careful about
 *
 * - **A missing run reads as "not found or unavailable".** `src/cloud/gateway.ts` maps every 404 to
 *   `unavailable`, because from the browser a deployment with no Worker and a run that is not
 *   yours are the same 404 — and deliberately so: answering `FORBIDDEN` on someone else's id would
 *   turn the id space into an enumeration oracle over colleagues' run codes. The screen phrases
 *   that ambiguity rather than guessing at it.
 * - **A Viewer sees everything and edits nothing.** Capabilities are checked for the controls, but
 *   the server is the enforcement: `analysis:update`, `poster:generate`, `raw:download` and
 *   `analysis:delete` are all checked in the Worker regardless of what this screen renders.
 * - **Nothing renders a poster without being asked.** Opening this screen lists figures and shows
 *   the PNGs that exist. The two POSTs that can start a render are behind buttons.
 */

import { hasCapability } from '@aat/shared'
import { useMemo, useState } from 'react'
import { formatBytes, formatFixed, formatSeconds } from '../app/format.ts'
import type { PosterFigure, RevisionSummary, RunSummary } from '../cloud/gateway.ts'
import { type PosterStatus, posterLabel } from '../cloud/status.ts'
import { Dialog } from '../components/Dialog.tsx'
import { useNotices } from '../components/hooks.ts'
import type { NoticeItem } from '../components/NoticeStack.tsx'
import { RunMemoEditor } from '../components/RunMemoEditor.tsx'
import { RunPosterImage } from '../components/RunPosterImage.tsx'
import { RunReplayPanel } from '../components/RunReplayPanel.tsx'
import { RunTagEditor } from '../components/RunTagEditor.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { Link, useNavigate, useRoute } from '../router/Router.tsx'
import { pickAutoPoster } from '../runs/facts.ts'
import {
  followsFilenameConvention,
  formatExperimentDate,
  formatMoment,
  suffixLabel,
} from '../runs/gallery.ts'
import type { RunMetrics } from '../runs/metrics.ts'
import { summariseGQuality } from '../runs/metrics.ts'
import type { SessionStatus } from '../session/SessionProvider.tsx'
import { useSession } from '../session/SessionProvider.tsx'
import {
  applySavedMemo,
  getSourceFor,
  type LoadState,
  openSnapshotFor,
  patchRunFor,
  type ReplayState,
  removeRunFor,
  runAutoPosterFor,
  type SourceState,
  saveTagsFor,
  useRunDetailData,
} from './run-detail-data.ts'

type Notify = (tone: NoticeItem['tone'], text: string) => void

/** The signed-out / loading / unavailable gate. */
function SignInNotice({ status }: { status: SessionStatus }): React.JSX.Element {
  return (
    <ScreenFrame title="実験の詳細" centred>
      <section className="panel panel--framed" aria-label="サインインが必要です">
        <p className="panel__hint">
          {status === 'loading'
            ? 'セッションを確認しています…'
            : status === 'unavailable'
              ? 'このデプロイではクラウド機能を利用できません。解析画面はすべて利用できます。'
              : '保存した実験を表示するにはサインインが必要です。'}
        </p>
        <div className="screen__actions">
          {status === 'signed-out' ? (
            <Link to="/sign-in" className="button button--primary">
              サインイン
            </Link>
          ) : null}
          <Link to="/" className="button button--flat">
            解析画面へ
          </Link>
        </div>
      </section>
    </ScreenFrame>
  )
}

/** Loading or failed — either way there is no run to show yet. */
function RunPending({ run }: { run: Exclude<LoadState<RunSummary>, { kind: 'ready' }> }): React.JSX.Element {
  return (
    <ScreenFrame title="実験の詳細">
      <section className="panel panel--framed" aria-label="実験">
        <p className="panel__hint" role="status" aria-live="polite">
          {run.kind === 'loading' ? '読み込んでいます…' : run.message}
        </p>
        <div className="screen__actions">
          <Link to="/runs" className="button button--flat">
            実験一覧へ
          </Link>
        </div>
      </section>
    </ScreenFrame>
  )
}

function NoticeList({
  notices,
  onDismiss,
}: {
  notices: readonly NoticeItem[]
  onDismiss: (id: number) => void
}): React.JSX.Element {
  return (
    <>
      {notices.map((notice) => (
        <div className={`notice notice--${notice.tone}`} key={notice.id} role="status">
          <span className="notice__body">{notice.text}</span>
          <button type="button" className="button button--flat" onClick={() => onDismiss(notice.id)}>
            閉じる
          </button>
        </div>
      ))}
    </>
  )
}

/** Which experiment this is: code, date, filename, when it was recorded. */
function RunInfoSection({ run }: { run: RunSummary }): React.JSX.Element {
  return (
    <section className="panel panel--framed" aria-label="実験の情報">
      <div className="panel__header">
        <h2 className="panel__title">実験</h2>
        <span className="panel__hint">
          {followsFilenameConvention(run) ? 'ファイル名は命名規則どおりです' : 'ファイル名は命名規則外です'}
        </span>
      </div>
      <div {...TABLE_SCROLL_PROPS}>
        <table className="data-table">
          <tbody>
            <tr>
              <th scope="row">実験コード</th>
              <td>{run.runCode}</td>
            </tr>
            <tr>
              <th scope="row">実験日</th>
              <td>{formatExperimentDate(run.experimentDate)}</td>
            </tr>
            <tr>
              <th scope="row">枝番</th>
              <td>{suffixLabel(run.suffix)}</td>
            </tr>
            <tr>
              <th scope="row">元のファイル名</th>
              <td>{run.originalFilename}</td>
            </tr>
            <tr>
              <th scope="row">登録日時</th>
              <td>{formatMoment(run.createdAt)}</td>
            </tr>
            <tr>
              <th scope="row">最終更新</th>
              <td>{formatMoment(run.updatedAt)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RevisionsSection({
  revisions,
  selectedRevisionId,
  onSelect,
}: {
  revisions: readonly RevisionSummary[]
  selectedRevisionId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="panel panel--framed" aria-label="解析リビジョン">
      <div className="panel__header">
        <h2 className="panel__title">解析リビジョン</h2>
        <span className="panel__hint">{revisions.length} 件</span>
      </div>
      {revisions.length === 0 ? (
        <p className="panel__hint">
          この実験にはまだ解析リビジョンがありません。解析画面でこのファイルを解析すると記録されます。
        </p>
      ) : (
        <div {...TABLE_SCROLL_PROPS}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">選択</span>
                </th>
                <th scope="col">リビジョン</th>
                <th scope="col">作成日時</th>
                <th scope="col">エンジン</th>
                <th scope="col">アプリ</th>
                <th scope="col">設定ハッシュ</th>
                <th scope="col">スナップショット</th>
              </tr>
            </thead>
            <tbody>
              {[...revisions]
                .sort((a, b) => b.revisionNumber - a.revisionNumber)
                .map((revision) => (
                  <tr key={revision.id}>
                    <td>
                      <label className="run-detail__revision-pick">
                        <input
                          type="radio"
                          name="revision"
                          checked={revision.id === selectedRevisionId}
                          onChange={() => onSelect(revision.id)}
                        />
                        <span className="visually-hidden">
                          リビジョン {revision.revisionNumber} を表示する
                        </span>
                      </label>
                    </td>
                    <td>r{revision.revisionNumber}</td>
                    <td>{formatMoment(revision.createdAt)}</td>
                    <td>{revision.engineVersion}</td>
                    <td>{revision.appVersion}</td>
                    <td>
                      <code className="run-detail__hash">{revision.configHash.slice(0, 12)}</code>
                    </td>
                    <td>{revision.hasSnapshot ? 'あり' : 'なし'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function MetricRow({
  label,
  stats,
  sampleCount,
}: {
  label: string
  stats: RunMetrics['inner'] | undefined
  sampleCount: number | undefined
}): React.JSX.Element {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="numeric">{formatSeconds(stats?.startTime)}</td>
      <td className="numeric">{formatFixed(stats?.mean, 6)}</td>
      <td className="numeric">{formatFixed(stats?.std, 6)}</td>
      <td className="numeric">{sampleCount?.toLocaleString('ja-JP') ?? '—'}</td>
    </tr>
  )
}

function MetricsTable({ metrics }: { metrics: RunMetrics | null }): React.JSX.Element {
  return (
    <div {...TABLE_SCROLL_PROPS}>
      <table className="data-table">
        <caption className="visually-hidden">最小標準偏差ウィンドウの統計</caption>
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
          <MetricRow label="Inner Capsule" stats={metrics?.inner} sampleCount={metrics?.innerSampleCount} />
          <MetricRow label="Drag Shield" stats={metrics?.drag} sampleCount={metrics?.dragSampleCount} />
        </tbody>
      </table>
    </div>
  )
}

function ProvenanceTable({ revision }: { revision: RevisionSummary }): React.JSX.Element {
  return (
    <div {...TABLE_SCROLL_PROPS}>
      <table className="data-table">
        <caption className="visually-hidden">来歴</caption>
        <tbody>
          <tr>
            <th scope="row">元データのSHA-256</th>
            <td>
              <code className="run-detail__hash">{revision.sourceSha256}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">設定ハッシュ</th>
            <td>
              <code className="run-detail__hash">{revision.configHash}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">スナップショット形式</th>
            <td>v{revision.snapshotFormatVersion}</td>
          </tr>
          {revision.notes === null ? null : (
            <tr>
              <th scope="row">備考</th>
              <td>{revision.notes}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/** The selected revision's window statistics and where they came from. */
function MetricsSection({
  revision,
  metrics,
}: {
  revision: RevisionSummary
  metrics: RunMetrics | null
}): React.JSX.Element {
  const gQuality = metrics === null ? null : summariseGQuality(metrics.gQuality)
  return (
    <section className="panel panel--framed" aria-label="この解析の指標">
      <div className="panel__header">
        <h2 className="panel__title">r{revision.revisionNumber} の指標</h2>
        <span className="panel__hint">
          {metrics === null ? '読み込み中' : `警告 ${metrics.warningCount} 件`}
        </span>
      </div>
      <MetricsTable metrics={metrics} />
      <p className="panel__hint">
        解析ウィンドウ {formatSeconds(metrics?.windowSize)} 秒 ・{' '}
        {gQuality === null
          ? 'G-quality: 未計算'
          : `G-quality: ${gQuality.windowCount} 窓 (${formatSeconds(gQuality.smallestWindow)}–${formatSeconds(gQuality.largestWindow)} s)`}
      </p>
      <ProvenanceTable revision={revision} />
    </section>
  )
}

function ReplayReady({
  revision,
  replay,
  runCode,
  canGeneratePoster,
  onPosterRendered,
  onNotice,
}: {
  revision: RevisionSummary
  replay: Extract<ReplayState, { kind: 'ready' }>['replay']
  runCode: string
  canGeneratePoster: boolean
  onPosterRendered: (poster: PosterFigure) => void
  onNotice: Notify
}): React.JSX.Element {
  return (
    <>
      <p className="panel__hint">
        r{revision.revisionNumber} のスナップショット（{replay.dataset.sampleCount.toLocaleString('ja-JP')}{' '}
        行、解析日時 {formatMoment(replay.snapshot.analysisTimestamp)}
        ）を表示しています。範囲選択・統計・Excel書き出し・ポスター生成は解析画面と同じ計算を使います。
      </p>
      {replay.warningCodes.length === 0 ? null : (
        <p className="notice notice--warning" role="status">
          <span className="notice__body">解析時の警告: {replay.warningCodes.join(', ')}</span>
        </p>
      )}
      <RunReplayPanel
        // A different revision is a different axis: the panel's selection
        // and viewport belong to the snapshot it was drawn from.
        key={revision.id}
        replay={replay}
        analysisRevisionId={revision.id}
        runCode={runCode}
        canGeneratePoster={canGeneratePoster}
        onPosterRendered={onPosterRendered}
        onNotice={onNotice}
      />
    </>
  )
}

function ReplayGate({ replay, onOpen }: { replay: ReplayState; onOpen: () => void }): React.JSX.Element {
  return (
    <>
      {replay.kind === 'error' ? (
        <p className="notice notice--error" role="status">
          <span className="notice__body">{replay.message}</span>
        </p>
      ) : null}
      <div className="screen__actions">
        <button
          type="button"
          className="button button--primary"
          disabled={replay.kind === 'loading'}
          onClick={onOpen}
        >
          {replay.kind === 'loading' ? '読み込んでいます…' : 'スナップショットを開く'}
        </button>
      </div>
    </>
  )
}

/** Open the selected revision's snapshot into the replay panel. */
function ReplaySection({
  revision,
  replay,
  runCode,
  canGeneratePoster,
  onOpenSnapshot,
  onPosterRendered,
  onNotice,
}: {
  revision: RevisionSummary | null
  replay: ReplayState
  runCode: string
  canGeneratePoster: boolean
  onOpenSnapshot: (revision: RevisionSummary) => void
  onPosterRendered: (poster: PosterFigure) => void
  onNotice: Notify
}): React.JSX.Element {
  return (
    <section className="panel panel--framed" aria-label="解析データ">
      <div className="panel__header">
        <h2 className="panel__title">解析データを開く</h2>
        <span className="panel__hint">
          {revision?.hasSnapshot === true ? '元のCSVは不要です' : 'スナップショットがありません'}
        </span>
      </div>

      {revision === null ? (
        <p className="panel__hint">リビジョンを選択してください。</p>
      ) : !revision.hasSnapshot ? (
        <p className="panel__hint">
          このリビジョンにはスナップショットが保存されていないため、グラフを再現できません。解析画面で元のCSVを開き直してください。
        </p>
      ) : replay.kind === 'ready' && replay.revisionId === revision.id ? (
        <ReplayReady
          revision={revision}
          replay={replay.replay}
          runCode={runCode}
          canGeneratePoster={canGeneratePoster}
          onPosterRendered={onPosterRendered}
          onNotice={onNotice}
        />
      ) : (
        <ReplayGate replay={replay} onOpen={() => onOpenSnapshot(revision)} />
      )}
    </section>
  )
}

function AutoPosterControls({
  autoPoster,
  replayReady,
  busy,
  canGeneratePoster,
  onGenerate,
  onRetry,
}: {
  autoPoster: PosterFigure | null
  replayReady: boolean
  busy: boolean
  canGeneratePoster: boolean
  onGenerate: () => void
  onRetry: (posterId: string) => void
}): React.JSX.Element {
  const openFirst = replayReady ? undefined : '先にスナップショットを開いてください'
  return (
    <div className="screen__actions">
      {autoPoster === null && canGeneratePoster ? (
        <button
          type="button"
          className="button"
          disabled={busy || !replayReady}
          title={openFirst}
          onClick={onGenerate}
        >
          自動ポスター図を生成
        </button>
      ) : null}
      {autoPoster !== null && autoPoster.status === 'failed' && canGeneratePoster ? (
        <button
          type="button"
          className="button"
          disabled={busy || !replayReady}
          title={openFirst}
          onClick={() => onRetry(autoPoster.posterId)}
        >
          生成をやり直す
        </button>
      ) : null}
    </div>
  )
}

function CustomPosterList({
  posters,
  runCode,
}: {
  posters: readonly PosterFigure[]
  runCode: string
}): React.JSX.Element {
  if (posters.length === 0) {
    return (
      <p className="panel__hint">
        カスタムのポスター図はありません。スナップショットを開き、範囲を選んで「ポスター図を作成」から生成できます。
      </p>
    )
  }
  return (
    <ul className="run-poster-list">
      {posters.map((poster) => (
        <li key={poster.posterId}>
          <RunPosterImage poster={poster} runCode={runCode} size="full" />
          <p className="panel__hint">
            {formatMoment(poster.createdAt)} ・ {poster.presetVersion}
            {poster.rendererVersion === null ? '' : ` ・ renderer ${poster.rendererVersion}`}
            {poster.status === 'failed'
              ? ' ・ 失敗しました。「ポスター図を作成」から作り直してください。'
              : ''}
          </p>
        </li>
      ))}
    </ul>
  )
}

/** The poster lane: the automatic figure, its retry, and the custom figures. */
function PostersSection({
  posters,
  autoPosterStatus,
  runCode,
  replayReady,
  busy,
  canGeneratePoster,
  onGenerate,
  onRetry,
}: {
  posters: readonly PosterFigure[]
  autoPosterStatus: PosterStatus
  runCode: string
  replayReady: boolean
  busy: boolean
  canGeneratePoster: boolean
  onGenerate: () => void
  onRetry: (posterId: string) => void
}): React.JSX.Element {
  const autoPoster = pickAutoPoster(posters)
  const customPosters = posters.filter((poster) => poster.kind === 'custom')
  return (
    <section className="panel panel--framed" aria-label="ポスター図">
      <div className="panel__header">
        <h2 className="panel__title">ポスター図</h2>
        <span className="panel__hint">{posters.length} 件</span>
      </div>

      <h3 className="panel__title">自動生成</h3>
      <RunPosterImage
        poster={autoPoster}
        runCode={runCode}
        size="full"
        absentLabel="このリビジョンの自動ポスター図はまだ生成されていません。"
      />
      <AutoPosterControls
        autoPoster={autoPoster}
        replayReady={replayReady}
        busy={busy}
        canGeneratePoster={canGeneratePoster}
        onGenerate={onGenerate}
        onRetry={onRetry}
      />
      {autoPosterStatus.kind === 'queued' || autoPosterStatus.kind === 'rendering' ? (
        <p className="panel__hint" role="status">
          {posterLabel(autoPosterStatus).text}
        </p>
      ) : null}

      <h3 className="panel__title">カスタム</h3>
      <CustomPosterList posters={customPosters} runCode={runCode} />
    </section>
  )
}

function sourceHint(source: SourceState): string {
  switch (source.kind) {
    case 'unknown':
      return '未確認'
    case 'checking':
      return '確認しています…'
    case 'present':
      return `保存されています（${formatBytes(source.bytes)}）`
    case 'absent':
      return 'バックアップはありません'
    case 'error':
      return source.message
  }
}

/** The original CSV backup — present or not, nobody knows until a download is asked for. */
function SourceSection({
  source,
  canDownload,
  onDownload,
}: {
  source: SourceState
  canDownload: boolean
  onDownload: () => void
}): React.JSX.Element {
  return (
    <section className="panel panel--framed" aria-label="元データのバックアップ">
      <div className="panel__header">
        <h2 className="panel__title">元のCSV</h2>
        <span className="panel__hint">{sourceHint(source)}</span>
      </div>
      <p className="panel__hint">
        元のCSVのバックアップは、解析ごとに明示的に依頼したときだけ保存されます。保存されているかどうかは、ダウンロードして初めて分かります（サーバーに存在確認だけを行う経路がないためです）。
      </p>
      <div className="screen__actions">
        <button
          type="button"
          className="button"
          disabled={!canDownload || source.kind === 'checking'}
          title={canDownload ? undefined : '元データをダウンロードする権限がありません'}
          onClick={onDownload}
        >
          元のCSVをダウンロード
        </button>
      </div>
    </section>
  )
}

function DeleteSection({
  canDelete,
  busy,
  onAsk,
}: {
  canDelete: boolean
  busy: boolean
  onAsk: () => void
}): React.JSX.Element | null {
  if (!canDelete) return null
  return (
    <section className="panel panel--framed" aria-label="実験の削除">
      <div className="panel__header">
        <h2 className="panel__title">この実験を削除</h2>
      </div>
      <p className="panel__hint">
        スナップショット・ポスター図・元データのバイト列は削除され、保存容量が戻ります。解析リビジョンの記録自体は監査のために残ります。取り消せません。
      </p>
      <div className="screen__actions">
        <button type="button" className="button" disabled={busy} onClick={onAsk}>
          削除する
        </button>
      </div>
    </section>
  )
}

function DeleteDialog({
  run,
  busy,
  onCancel,
  onConfirm,
}: {
  run: RunSummary
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <Dialog
      title="実験を削除しますか"
      description={`${run.runCode}（${run.originalFilename}）を削除します。保存されているスナップショット、ポスター図、元データのCSVがすべて削除され、取り消すことはできません。`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="button button--flat" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button type="button" className="button button--primary" disabled={busy} onClick={onConfirm}>
            削除する
          </button>
        </>
      }
    >
      <p className="panel__hint">この操作は監査ログに記録されます。</p>
    </Dialog>
  )
}

export function RunDetailScreen(): React.JSX.Element {
  const route = useRoute()
  const navigate = useNavigate()
  const session = useSession()
  const runId = route.params.runId ?? ''

  const {
    mounted,
    run,
    setRun,
    revisions,
    selectedRevisionId,
    setSelectedRevisionId,
    metrics,
    posters,
    setPosters,
    replay,
    setReplay,
    source,
    setSource,
  } = useRunDetailData(session.status, runId)
  const { notices, notify, dismissNotice } = useNotices(4)
  const [busy, setBusy] = useState(false)
  // The renderer's queue position and progress for the auto poster. A render
  // can poll for up to two minutes; without a status the only feedback is a
  // disabled button.
  const [autoPosterStatus, setAutoPosterStatus] = useState<PosterStatus>({ kind: 'unavailable' })
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const capabilities = session.capabilities
  const canEdit = hasCapability(capabilities, 'analysis:update')
  const canGeneratePoster = hasCapability(capabilities, 'poster:generate')
  const canDownloadSource = hasCapability(capabilities, 'raw:download')
  const canDelete = hasCapability(capabilities, 'analysis:delete')

  const selectedRevision = useMemo(
    () => revisions.find((revision) => revision.id === selectedRevisionId) ?? null,
    [revisions, selectedRevisionId],
  )

  /* --------------------------------------------------------------- actions */

  const openSnapshot = (revision: RevisionSummary) => openSnapshotFor(mounted, revision, setReplay)
  const runAutoPoster = (posterId: string | null) =>
    runAutoPosterFor({ mounted, replay, run, notify, setBusy, setAutoPosterStatus, setPosters }, posterId)
  const getSource = () => getSourceFor({ mounted, run, runId, setSource })
  const removeRun = () => removeRunFor({ runId, setBusy, setConfirmingDelete, notify, navigate })

  /* ---------------------------------------------------------------- render */

  if (session.status !== 'signed-in') return <SignInNotice status={session.status} />
  if (run.kind !== 'ready') return <RunPending run={run} />

  const current = run.value

  return (
    <ScreenFrame title={current.runCode} description={current.originalFilename}>
      <p className="run-detail__back">
        <Link to="/runs">← 実験一覧</Link>
      </p>

      <NoticeList notices={notices} onDismiss={dismissNotice} />

      <RunInfoSection run={current} />

      <section className="panel panel--framed" aria-label="メモ">
        <div className="panel__header">
          <h2 className="panel__title">メモ</h2>
        </div>
        <RunMemoEditor
          memo={current.memo}
          readOnly={!canEdit}
          onSave={(value) => patchRunFor(runId, { memo: value }, null, notify)}
          onSaved={(value) => applySavedMemo(setRun, value)}
        />
      </section>

      <section className="panel panel--framed" aria-label="タグ">
        <div className="panel__header">
          <h2 className="panel__title">タグ</h2>
        </div>
        <RunTagEditor
          tags={current.tags}
          readOnly={!canEdit}
          busy={busy}
          onChange={(tags) => saveTagsFor({ runId, current, mounted, notify, setRun }, tags)}
        />
      </section>

      <RevisionsSection
        revisions={revisions}
        selectedRevisionId={selectedRevisionId}
        onSelect={setSelectedRevisionId}
      />

      {selectedRevision === null ? null : <MetricsSection revision={selectedRevision} metrics={metrics} />}

      <ReplaySection
        revision={selectedRevision}
        replay={replay}
        runCode={current.runCode}
        canGeneratePoster={canGeneratePoster}
        onOpenSnapshot={(revision) => void openSnapshot(revision)}
        onPosterRendered={(poster) =>
          setPosters((all) => [poster, ...all.filter((p) => p.posterId !== poster.posterId)])
        }
        onNotice={notify}
      />

      <PostersSection
        posters={posters}
        autoPosterStatus={autoPosterStatus}
        runCode={current.runCode}
        replayReady={replay.kind === 'ready'}
        busy={busy}
        canGeneratePoster={canGeneratePoster}
        onGenerate={() => void runAutoPoster(null)}
        onRetry={(posterId) => void runAutoPoster(posterId)}
      />

      <SourceSection source={source} canDownload={canDownloadSource} onDownload={() => void getSource()} />

      <DeleteSection canDelete={canDelete} busy={busy} onAsk={() => setConfirmingDelete(true)} />

      {confirmingDelete ? (
        <DeleteDialog
          run={current}
          busy={busy}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void removeRun()}
        />
      ) : null}
    </ScreenFrame>
  )
}
