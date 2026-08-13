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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes, formatFixed, formatSeconds } from '../app/format.ts'
import {
  deleteRun,
  fetchRevision,
  fetchRun,
  listPosters,
  listRevisions,
  type PosterFigure,
  type RevisionSummary,
  type RunSummary,
  updateRun,
} from '../cloud/gateway.ts'
import { Dialog } from '../components/Dialog.tsx'
import { type MemoSaveOutcome, RunMemoEditor } from '../components/RunMemoEditor.tsx'
import { RunPosterImage } from '../components/RunPosterImage.tsx'
import { RunReplayPanel } from '../components/RunReplayPanel.tsx'
import { RunTagEditor } from '../components/RunTagEditor.tsx'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { saveBlob } from '../exporting/client.ts'
import { generateAutoPoster, type PosterContext, retryAutoPoster } from '../poster/requests.ts'
import { Link, useNavigate, useRoute } from '../router/Router.tsx'
import { downloadSourceBackup, fetchSnapshotBytes } from '../runs/api.ts'
import { latestRevision, pickAutoPoster } from '../runs/facts.ts'
import {
  followsFilenameConvention,
  formatExperimentDate,
  formatMoment,
  suffixLabel,
} from '../runs/gallery.ts'
import { decodeRunMetrics, type RunMetrics, summariseGQuality } from '../runs/metrics.ts'
import { decodeSnapshotBytes, type ReplayedAnalysis, replayFromSnapshot } from '../runs/replay.ts'
import { useSession } from '../session/SessionProvider.tsx'

interface Notice {
  id: number
  tone: 'info' | 'warning' | 'error'
  text: string
}

type LoadState<T> = { kind: 'loading' } | { kind: 'ready'; value: T } | { kind: 'error'; message: string }

type ReplayState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; revisionId: string; replay: ReplayedAnalysis }
  | { kind: 'error'; message: string }

/**
 * What is known about the original-CSV backup.
 *
 * `unknown` is the honest starting point and stays that way until the reader asks. There is no
 * route that reports whether a source object exists without streaming it, and streaming it writes
 * a `source.download` entry to the audit log — so probing on page load would put a record of a
 * download nobody performed into the security log in order to fill in a badge. See
 * `src/runs/api.ts`.
 */
type SourceState =
  | { kind: 'unknown' }
  | { kind: 'checking' }
  | { kind: 'present'; bytes: number; filename: string }
  | { kind: 'absent' }
  | { kind: 'error'; message: string }

export function RunDetailScreen(): React.JSX.Element {
  const route = useRoute()
  const navigate = useNavigate()
  const session = useSession()
  const runId = route.params.runId ?? ''

  const [run, setRun] = useState<LoadState<RunSummary>>({ kind: 'loading' })
  const [revisions, setRevisions] = useState<readonly RevisionSummary[]>([])
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [metrics, setMetrics] = useState<RunMetrics | null>(null)
  const [posters, setPosters] = useState<readonly PosterFigure[]>([])
  const [replay, setReplay] = useState<ReplayState>({ kind: 'idle' })
  const [source, setSource] = useState<SourceState>({ kind: 'unknown' })
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const mounted = useRef(true)
  const noticeId = useRef(0)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )

  const notify = useCallback((tone: Notice['tone'], text: string) => {
    noticeId.current += 1
    const id = noticeId.current
    setNotices((current) => [...current, { id, tone, text }].slice(-4))
  }, [])

  const capabilities = session.capabilities
  const canEdit = hasCapability(capabilities, 'analysis:update')
  const canGeneratePoster = hasCapability(capabilities, 'poster:generate')
  const canDownloadSource = hasCapability(capabilities, 'raw:download')
  const canDelete = hasCapability(capabilities, 'analysis:delete')

  /* ------------------------------------------------------------------ load */

  useEffect(() => {
    if (session.status !== 'signed-in' || runId === '') return
    setRun({ kind: 'loading' })
    void fetchRun(runId).then((outcome) => {
      if (!mounted.current) return
      setRun(
        outcome.ok
          ? { kind: 'ready', value: outcome.value.run }
          : {
              kind: 'error',
              // The gateway cannot distinguish "no cloud" from "no such run", so neither does this.
              message:
                outcome.kind === 'unavailable'
                  ? 'この実験は見つからないか、クラウドに接続できません。一覧から選び直してください。'
                  : outcome.message,
            },
      )
    })
  }, [session.status, runId])

  useEffect(() => {
    if (session.status !== 'signed-in' || runId === '') return
    void listRevisions(runId).then((outcome) => {
      if (!mounted.current || !outcome.ok) return
      setRevisions(outcome.value.revisions)
      // The current analysis is the highest revision number — see `latestRevision` for why not the
      // newest timestamp.
      setSelectedRevisionId((current) => current ?? latestRevision(outcome.value.revisions)?.id ?? null)
    })
  }, [session.status, runId])

  useEffect(() => {
    if (selectedRevisionId === null) return
    setMetrics(null)
    setPosters([])
    void fetchRevision(selectedRevisionId).then((outcome) => {
      if (!mounted.current || !outcome.ok) return
      setMetrics(decodeRunMetrics(outcome.value.metrics))
    })
    void listPosters(selectedRevisionId).then((outcome) => {
      if (!mounted.current || !outcome.ok) return
      setPosters(outcome.value.posters)
    })
  }, [selectedRevisionId])

  const selectedRevision = useMemo(
    () => revisions.find((revision) => revision.id === selectedRevisionId) ?? null,
    [revisions, selectedRevisionId],
  )
  const autoPoster = useMemo(() => pickAutoPoster(posters), [posters])
  const customPosters = useMemo(() => posters.filter((poster) => poster.kind === 'custom'), [posters])
  const gQuality = useMemo(() => (metrics === null ? null : summariseGQuality(metrics.gQuality)), [metrics])

  // A revision change invalidates a replay: the samples on screen belong to the analysis that was
  // open, and silently leaving them under a different revision's heading would attribute one
  // measurement's numbers to another.
  useEffect(() => {
    setReplay((current) =>
      current.kind === 'ready' && current.revisionId !== selectedRevisionId ? { kind: 'idle' } : current,
    )
  }, [selectedRevisionId])

  /* --------------------------------------------------------------- actions */

  const patchRun = async (
    patch: { memo?: string | null; tags?: readonly string[] },
    successText: string | null,
  ): Promise<MemoSaveOutcome> => {
    const outcome = await updateRun(runId, patch)
    if (!outcome.ok) {
      return {
        ok: false,
        message: outcome.message,
        retryable: outcome.kind === 'unavailable' || outcome.retryable,
      }
    }
    if (successText !== null) notify('info', successText)
    return { ok: true }
  }

  const openSnapshot = async (revision: RevisionSummary) => {
    setReplay({ kind: 'loading' })
    const outcome = await fetchSnapshotBytes(revision.id)
    if (!mounted.current) return
    if (!outcome.ok) {
      setReplay({
        kind: 'error',
        message:
          outcome.kind === 'error' && outcome.code === 'RESOURCE_NOT_FOUND'
            ? 'このリビジョンにはスナップショットが保存されていません。'
            : outcome.message,
      })
      return
    }
    try {
      const snapshot = await decodeSnapshotBytes(outcome.value)
      if (!mounted.current) return
      setReplay({ kind: 'ready', revisionId: revision.id, replay: replayFromSnapshot(snapshot) })
    } catch (error) {
      if (!mounted.current) return
      setReplay({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Ask for the automatic figure, or retry one that failed.
   *
   * Both go through `src/poster/requests.ts`, which is the analyzer's own path: it builds the spec
   * from the frozen preset and the dataset's branded arrays, submits it, and polls the *listing* —
   * never the render endpoint — until the figure settles. Sharing that rather than reimplementing
   * it is what keeps "the automatic poster of this revision" one document with one spec hash,
   * whichever screen asked for it.
   *
   * Retry is offered for the automatic figure only. `POST /posters/:id/retry` needs the full spec
   * in the body, and `listPosters` returns a figure's status and hashes but not its document — so a
   * custom figure's range, size and DPI cannot be reconstructed from anything this screen holds.
   * Retrying it with invented parameters under its original id would file a different picture as
   * the same one, so the panel says to re-create it from the dialog instead.
   */
  const runAutoPoster = async (posterId: string | null) => {
    if (replay.kind !== 'ready' || run.kind !== 'ready') return
    const context: PosterContext = {
      revisionId: replay.revisionId,
      runCode: run.value.runCode,
      dataset: replay.replay.dataset,
    }
    setBusy(true)
    const outcome =
      posterId === null
        ? await generateAutoPoster(context, () => {})
        : await retryAutoPoster(context, posterId, () => {})
    if (!mounted.current) return
    setBusy(false)

    if (!outcome.ok) {
      // A spec refusal is advice with the numbers in it; a cloud refusal is the taxonomy message.
      notify(
        'error',
        outcome.kind === 'spec'
          ? [outcome.advice.message, outcome.advice.detail].filter((part) => part !== null).join('\n')
          : outcome.message,
      )
      return
    }
    setPosters((current) => [
      outcome.poster,
      ...current.filter((existing) => existing.posterId !== outcome.poster.posterId),
    ])
    notify('info', '自動ポスター図を生成しました。')
  }

  const getSource = async () => {
    if (run.kind !== 'ready') return
    setSource({ kind: 'checking' })
    const outcome = await downloadSourceBackup(runId)
    if (!mounted.current) return
    if (!outcome.ok) {
      setSource(
        outcome.kind === 'error' && outcome.code === 'RESOURCE_NOT_FOUND'
          ? { kind: 'absent' }
          : { kind: 'error', message: outcome.message },
      )
      return
    }
    const filename = outcome.value.filename ?? run.value.originalFilename
    saveBlob(outcome.value.blob, filename)
    setSource({ kind: 'present', bytes: outcome.value.blob.size, filename })
  }

  const removeRun = async () => {
    setBusy(true)
    const outcome = await deleteRun(runId)
    setBusy(false)
    setConfirmingDelete(false)
    if (!outcome.ok) {
      notify('error', outcome.message)
      return
    }
    navigate('/runs')
  }

  /* ---------------------------------------------------------------- render */

  if (session.status !== 'signed-in') {
    return (
      <ScreenFrame title="実験の詳細" centred>
        <section className="panel panel--framed" aria-label="サインインが必要です">
          <p className="panel__hint">
            {session.status === 'loading'
              ? 'セッションを確認しています…'
              : session.status === 'unavailable'
                ? 'このデプロイではクラウド機能を利用できません。解析画面はすべて利用できます。'
                : '保存した実験を表示するにはサインインが必要です。'}
          </p>
          <div className="screen__actions">
            {session.status === 'signed-out' ? (
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

  if (run.kind !== 'ready') {
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

  const current = run.value

  return (
    <ScreenFrame title={current.runCode} description={current.originalFilename}>
      <p className="run-detail__back">
        <Link to="/runs">← 実験一覧</Link>
      </p>

      {notices.map((notice) => (
        <div className={`notice notice--${notice.tone}`} key={notice.id} role="status">
          <span className="notice__body">{notice.text}</span>
          <button
            type="button"
            className="button button--flat"
            onClick={() => setNotices((all) => all.filter((n) => n.id !== notice.id))}
          >
            閉じる
          </button>
        </div>
      ))}

      <section className="panel panel--framed" aria-label="実験の情報">
        <div className="panel__header">
          <h2 className="panel__title">実験</h2>
          <span className="panel__hint">
            {followsFilenameConvention(current)
              ? 'ファイル名は命名規則どおりです'
              : 'ファイル名は命名規則外です'}
          </span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <tbody>
              <tr>
                <th scope="row">実験コード</th>
                <td>{current.runCode}</td>
              </tr>
              <tr>
                <th scope="row">実験日</th>
                <td>{formatExperimentDate(current.experimentDate)}</td>
              </tr>
              <tr>
                <th scope="row">枝番</th>
                <td>{suffixLabel(current.suffix)}</td>
              </tr>
              <tr>
                <th scope="row">元のファイル名</th>
                <td>{current.originalFilename}</td>
              </tr>
              <tr>
                <th scope="row">登録日時</th>
                <td>{formatMoment(current.createdAt)}</td>
              </tr>
              <tr>
                <th scope="row">最終更新</th>
                <td>{formatMoment(current.updatedAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel panel--framed" aria-label="メモ">
        <div className="panel__header">
          <h2 className="panel__title">メモ</h2>
        </div>
        <RunMemoEditor
          memo={current.memo}
          readOnly={!canEdit}
          onSave={(value) => patchRun({ memo: value }, null)}
          // Functional, so the write advances whatever the screen holds now rather than the copy
          // this render closed over — a debounced save can land several renders later.
          onSaved={(value) =>
            setRun((state) =>
              state.kind === 'ready' ? { kind: 'ready', value: { ...state.value, memo: value } } : state,
            )
          }
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
          onChange={(tags) => {
            const previous = current.tags
            setRun((state) =>
              state.kind === 'ready' ? { kind: 'ready', value: { ...state.value, tags: [...tags] } } : state,
            )
            void patchRun({ tags }, 'タグを保存しました。').then((outcome) => {
              // Roll the optimistic change back rather than leaving the screen showing a tag the
              // database does not have.
              if (!outcome.ok && mounted.current) {
                setRun((state) =>
                  state.kind === 'ready'
                    ? { kind: 'ready', value: { ...state.value, tags: [...previous] } }
                    : state,
                )
                notify('error', outcome.message)
              }
            })
          }}
        />
      </section>

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
          <div className="table-scroll">
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
                            onChange={() => setSelectedRevisionId(revision.id)}
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

      {selectedRevision === null ? null : (
        <section className="panel panel--framed" aria-label="この解析の指標">
          <div className="panel__header">
            <h2 className="panel__title">r{selectedRevision.revisionNumber} の指標</h2>
            <span className="panel__hint">
              {metrics === null ? '読み込み中' : `警告 ${metrics.warningCount} 件`}
            </span>
          </div>
          <div className="table-scroll">
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
          <p className="panel__hint">
            解析ウィンドウ {formatSeconds(metrics?.windowSize)} 秒 ・{' '}
            {gQuality === null
              ? 'G-quality: 未計算'
              : `G-quality: ${gQuality.windowCount} 窓 (${formatSeconds(gQuality.smallestWindow)}–${formatSeconds(gQuality.largestWindow)} s)`}
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">来歴</caption>
              <tbody>
                <tr>
                  <th scope="row">元データのSHA-256</th>
                  <td>
                    <code className="run-detail__hash">{selectedRevision.sourceSha256}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">設定ハッシュ</th>
                  <td>
                    <code className="run-detail__hash">{selectedRevision.configHash}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">スナップショット形式</th>
                  <td>v{selectedRevision.snapshotFormatVersion}</td>
                </tr>
                {selectedRevision.notes === null ? null : (
                  <tr>
                    <th scope="row">備考</th>
                    <td>{selectedRevision.notes}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel panel--framed" aria-label="解析データ">
        <div className="panel__header">
          <h2 className="panel__title">解析データを開く</h2>
          <span className="panel__hint">
            {selectedRevision?.hasSnapshot === true ? '元のCSVは不要です' : 'スナップショットがありません'}
          </span>
        </div>

        {selectedRevision === null ? (
          <p className="panel__hint">リビジョンを選択してください。</p>
        ) : !selectedRevision.hasSnapshot ? (
          <p className="panel__hint">
            このリビジョンにはスナップショットが保存されていないため、グラフを再現できません。解析画面で元のCSVを開き直してください。
          </p>
        ) : replay.kind === 'ready' && replay.revisionId === selectedRevision.id ? (
          <>
            <p className="panel__hint">
              r{selectedRevision.revisionNumber} のスナップショット（
              {replay.replay.dataset.sampleCount.toLocaleString('ja-JP')} 行、解析日時{' '}
              {formatMoment(replay.replay.snapshot.analysisTimestamp)}
              ）を表示しています。範囲選択・統計・Excel書き出し・ポスター生成は解析画面と同じ計算を使います。
            </p>
            {replay.replay.warningCodes.length === 0 ? null : (
              <p className="notice notice--warning" role="status">
                <span className="notice__body">解析時の警告: {replay.replay.warningCodes.join(', ')}</span>
              </p>
            )}
            <RunReplayPanel
              replay={replay.replay}
              analysisRevisionId={selectedRevision.id}
              runCode={current.runCode}
              canGeneratePoster={canGeneratePoster}
              onPosterRendered={(poster) =>
                setPosters((all) => [poster, ...all.filter((p) => p.posterId !== poster.posterId)])
              }
              onNotice={notify}
            />
          </>
        ) : (
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
                onClick={() => void openSnapshot(selectedRevision)}
              >
                {replay.kind === 'loading' ? '読み込んでいます…' : 'スナップショットを開く'}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel panel--framed" aria-label="ポスター図">
        <div className="panel__header">
          <h2 className="panel__title">ポスター図</h2>
          <span className="panel__hint">{posters.length} 件</span>
        </div>

        <h3 className="panel__title">自動生成</h3>
        <RunPosterImage
          poster={autoPoster}
          runCode={current.runCode}
          size="full"
          absentLabel="このリビジョンの自動ポスター図はまだ生成されていません。"
        />
        <div className="screen__actions">
          {autoPoster === null && canGeneratePoster ? (
            <button
              type="button"
              className="button"
              disabled={busy || replay.kind !== 'ready'}
              title={replay.kind === 'ready' ? undefined : '先にスナップショットを開いてください'}
              onClick={() => void runAutoPoster(null)}
            >
              自動ポスター図を生成
            </button>
          ) : null}
          {autoPoster !== null && autoPoster.status === 'failed' && canGeneratePoster ? (
            <button
              type="button"
              className="button"
              disabled={busy || replay.kind !== 'ready'}
              title={replay.kind === 'ready' ? undefined : '先にスナップショットを開いてください'}
              onClick={() => void runAutoPoster(autoPoster.posterId)}
            >
              生成をやり直す
            </button>
          ) : null}
        </div>

        <h3 className="panel__title">カスタム</h3>
        {customPosters.length === 0 ? (
          <p className="panel__hint">
            カスタムのポスター図はありません。スナップショットを開き、範囲を選んで「ポスター図を作成」から生成できます。
          </p>
        ) : (
          <ul className="run-poster-list">
            {customPosters.map((poster) => (
              <li key={poster.posterId}>
                <RunPosterImage poster={poster} runCode={current.runCode} size="full" />
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
        )}
      </section>

      <section className="panel panel--framed" aria-label="元データのバックアップ">
        <div className="panel__header">
          <h2 className="panel__title">元のCSV</h2>
          <span className="panel__hint">
            {source.kind === 'unknown'
              ? '未確認'
              : source.kind === 'checking'
                ? '確認しています…'
                : source.kind === 'present'
                  ? `保存されています（${formatBytes(source.bytes)}）`
                  : source.kind === 'absent'
                    ? 'バックアップはありません'
                    : source.message}
          </span>
        </div>
        <p className="panel__hint">
          元のCSVのバックアップは、解析ごとに明示的に依頼したときだけ保存されます。保存されているかどうかは、ダウンロードして初めて分かります（サーバーに存在確認だけを行う経路がないためです）。
        </p>
        <div className="screen__actions">
          <button
            type="button"
            className="button"
            disabled={!canDownloadSource || source.kind === 'checking'}
            title={canDownloadSource ? undefined : '元データをダウンロードする権限がありません'}
            onClick={() => void getSource()}
          >
            元のCSVをダウンロード
          </button>
        </div>
      </section>

      {canDelete ? (
        <section className="panel panel--framed" aria-label="実験の削除">
          <div className="panel__header">
            <h2 className="panel__title">この実験を削除</h2>
          </div>
          <p className="panel__hint">
            スナップショット・ポスター図・元データのバイト列は削除され、保存容量が戻ります。解析リビジョンの記録自体は監査のために残ります。取り消せません。
          </p>
          <div className="screen__actions">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => setConfirmingDelete(true)}
            >
              削除する
            </button>
          </div>
        </section>
      ) : null}

      {confirmingDelete ? (
        <Dialog
          title="実験を削除しますか"
          description={`${current.runCode}（${current.originalFilename}）を削除します。保存されているスナップショット、ポスター図、元データのCSVがすべて削除され、取り消すことはできません。`}
          onClose={() => setConfirmingDelete(false)}
          footer={
            <>
              <button
                type="button"
                className="button button--flat"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void removeRun()}
              >
                削除する
              </button>
            </>
          }
        >
          <p className="panel__hint">この操作は監査ログに記録されます。</p>
        </Dialog>
      ) : null}
    </ScreenFrame>
  )
}
