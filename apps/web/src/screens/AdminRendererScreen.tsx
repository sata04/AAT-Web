/**
 * `/admin/renderer` — the poster renderer, and an honest account of how little can be seen of it.
 *
 * The renderer is a pinned Python + Matplotlib container reached through a Durable Object. It does
 * no analysis: it receives numbers the browser already computed plus a validated plot spec, and
 * draws them. Keeping it that narrow is what makes it cheap, and the cost design is the reason this
 * screen looks the way it does.
 *
 * ## There is deliberately no "keep the container warm" control
 *
 * Short-lived on-demand rendering *is* the design. `wrangler.jsonc` caps the fleet at one instance
 * and the sleep-after timeout in `worker/container/poster-renderer.ts` is deliberately short,
 * because a container that stays warm between the two posters a researcher generates in a day is a
 * container billed for a day. A "keep alive" switch would trade a few seconds of cold start for a
 * standing cost, on a screen whose entire purpose is watching that cost. It is not offered, and
 * saying so here is cheaper than someone adding it later.
 *
 * ## What can be shown, and what has no route at all
 *
 * The Worker exposes one renderer fact: the circuit breaker. Everything else on this screen is
 * either derived from a *window* of the audit log — always labelled with its denominator, never as
 * a rate — or inspected one run at a time. A failed render writes no audit entry, so a
 * deployment-wide failure count cannot be computed from anything reachable; the per-run inspection
 * below is the only way to find a figure sitting in `failed`, and it is a lookup rather than a
 * sweep for that reason.
 *
 * ## Retry lives on the run screen, not here
 *
 * `POST /api/v1/posters/:id/retry` takes the full plot spec in the body — the Worker never replays
 * a stored one — and that spec is rebuilt from the revision's full-resolution snapshot. Retrying
 * from here would mean an admin console downloading measurement data, which is exactly what
 * `/admin` does not do. So a failed figure links to its run, where the snapshot is already loaded
 * and the existing retry path lives.
 */

import { hasCapability } from '@aat/shared'
import { useCallback, useState } from 'react'
import { listAuditEntries, listWorkspaceRuns, type WorkspaceRunSummary } from '../admin/api.ts'
import { formatBytes, formatCount, formatInstant, formatMoment } from '../admin/format.ts'
import {
  CLIENT_POSTER_PRESET_VERSION,
  observeRenderer,
  RENDERER_UNAVAILABLE_FACTS,
} from '../admin/renderer.ts'
import { inspectRun, type RunInspection } from '../admin/runs.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import { fetchRendererBreaker } from '../cloud/gateway.ts'
import { AdminBreakerControl } from '../components/AdminBreakerControl.tsx'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

/** How much of the audit log the renderer summary reads. Two pages' worth of activity. */
const AUDIT_SAMPLE = 100

/** How many runs the diagnostics lookup returns. A lookup, not a listing. */
const LOOKUP_LIMIT = 10

const POSTER_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: '待機中',
  rendering: '生成中',
  ready: '生成済み',
  failed: '失敗',
}

export function AdminRendererScreen(): React.JSX.Element {
  const session = useSession()
  const canManageQuota = hasCapability(session.capabilities, 'quota:manage')
  const canReadAudit = hasCapability(session.capabilities, 'audit:read')
  const canReadWorkspace = hasCapability(session.capabilities, 'workspace:read')

  const [notice, setNotice] = useState<string | null>(null)
  const [lookup, setLookup] = useState('')
  const [lookupSubmitted, setLookupSubmitted] = useState('')
  const [inspections, setInspections] = useState<ReadonlyMap<string, RunInspection>>(new Map())
  const [inspecting, setInspecting] = useState<string | null>(null)

  const breaker = useAdminResource(
    useCallback(() => fetchRendererBreaker(), []),
    'renderer',
    canManageQuota,
  )
  const audit = useAdminResource(
    useCallback(() => listAuditEntries({ limit: AUDIT_SAMPLE }), []),
    'audit',
    canReadAudit,
  )
  const runs = useAdminResource(
    useCallback(
      () =>
        listWorkspaceRuns(
          lookupSubmitted === '' ? { limit: LOOKUP_LIMIT } : { search: lookupSubmitted, limit: LOOKUP_LIMIT },
        ),
      [lookupSubmitted],
    ),
    `runs:${lookupSubmitted}`,
    canReadWorkspace,
  )

  const observations = observeRenderer(audit.resource.kind === 'ready' ? audit.resource.value.entries : [])

  const inspect = async (run: WorkspaceRunSummary) => {
    setInspecting(run.id)
    const outcome = await inspectRun(run.id)
    setInspecting(null)
    if (!outcome.ok) {
      setNotice(outcome.message)
      return
    }
    const value = outcome.value
    setInspections((current) => new Map(current).set(run.id, value))
  }

  return (
    <AdminFrame
      title="ポスターレンダラー"
      description="ポスター図を描画するコンテナの状態です。コンテナは解析を行わず、ブラウザが計算した数値と検証済みの描画仕様だけを受け取ります。停止してもローカルの解析・グラフ・書き出しには影響しません。"
    >
      {notice === null ? null : (
        <div className="notice notice--error" role="alert">
          <span className="notice__body">{notice}</span>
          <button type="button" className="button button--flat" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      <section className="panel panel--framed" aria-label="サーキットブレーカー">
        <div className="panel__header">
          <h2 className="panel__title">サーキットブレーカー</h2>
        </div>
        {!canManageQuota ? <AdminCapabilityNotice capability="quota:manage" /> : null}
        <AdminResourceNotice
          resource={breaker.resource}
          label="レンダラーの状態"
          enabled={canManageQuota}
          onRetry={breaker.reload}
        />
        {breaker.resource.kind === 'ready' ? (
          <AdminBreakerControl
            state={breaker.resource.value.circuitBreaker}
            onChanged={(state) => breaker.set({ circuitBreaker: state })}
            onFailure={setNotice}
          />
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="バージョン">
        <div className="panel__header">
          <h2 className="panel__title">バージョン</h2>
        </div>
        <dl className="admin-facts">
          <div className="admin-facts__row">
            <dt>レンダラー</dt>
            <dd>
              {observations.latestRendererVersion === null
                ? '直近の監査ログに成功したレンダリングがありません（コンテナが応答したバージョンは、成功時にのみ記録されます）'
                : `${observations.latestRendererVersion}（最後に成功したレンダリング: ${formatInstant(observations.latestRenderAt)}）`}
            </dd>
          </div>
          <div className="admin-facts__row">
            <dt>直近に確認されたレンダラー</dt>
            <dd>
              {observations.rendererVersions.length === 0 ? '—' : observations.rendererVersions.join(' / ')}
              {observations.rendererVersions.length > 1
                ? '（複数のバージョンが記録されています。ロールアウト中か、切り戻しが行われた可能性があります）'
                : ''}
            </dd>
          </div>
          <div className="admin-facts__row">
            <dt>ポスターのプリセット</dt>
            <dd>
              {CLIENT_POSTER_PRESET_VERSION}
              （このビルドが送信する版。図ごとの実際の版は poster_figures.preset_version に記録されます）
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel panel--framed" aria-label="直近の生成状況">
        <div className="panel__header">
          <h2 className="panel__title">直近の生成状況</h2>
        </div>
        {!canReadAudit ? <AdminCapabilityNotice capability="audit:read" /> : null}
        <AdminResourceNotice
          resource={audit.resource}
          label="監査ログ"
          enabled={canReadAudit}
          onRetry={audit.reload}
        />
        {audit.resource.kind === 'ready' ? (
          <>
            <dl className="admin-facts admin-facts--grid">
              <div className="admin-facts__row">
                <dt>生成（成功）</dt>
                <dd>{formatCount(observations.rendered)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>再試行</dt>
                <dd>{formatCount(observations.retried)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>図の取得</dt>
                <dd>{formatCount(observations.downloaded)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>生成されたPNGの合計</dt>
                <dd>{observations.renderedBytes === 0 ? '—' : formatBytes(observations.renderedBytes)}</dd>
              </div>
            </dl>
            <p className="panel__hint">
              直近 {formatCount(observations.sampled)} 件の監査ログを数えた結果です（最も古い記録:{' '}
              {formatInstant(observations.oldest)}
              ）。単位時間あたりの件数ではありません。失敗したレンダリングは監査ログに残らないため、ここに現れるのは成功と再試行だけです。再試行の件数は、失敗が起きたことの下限にあたります。
            </p>
          </>
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="失敗した図の確認">
        <div className="panel__header">
          <h2 className="panel__title">失敗した図の確認</h2>
        </div>
        {!canReadWorkspace ? <AdminCapabilityNotice capability="workspace:read" /> : null}
        <p className="panel__hint">
          図の状態はリビジョン単位でしか取得できないため、実験を指定して確認します。デプロイ全体を走査する経路はありません。
        </p>

        <search aria-label="実験の検索">
          <form
            className="run-filter"
            onSubmit={(event) => {
              event.preventDefault()
              setLookupSubmitted(lookup.trim())
            }}
          >
            <div className="run-filter__fields">
              <label className="field">
                <span className="field__label">実験コード・ファイル名</span>
                <input
                  className="input"
                  type="search"
                  maxLength={128}
                  value={lookup}
                  onChange={(event) => setLookup(event.target.value)}
                />
              </label>
            </div>
            <div className="screen__actions">
              <button type="submit" className="button">
                実験を探す
              </button>
            </div>
          </form>
        </search>

        <AdminResourceNotice
          resource={runs.resource}
          label="実験の一覧"
          enabled={canReadWorkspace}
          onRetry={runs.reload}
        />

        {runs.resource.kind === 'ready' ? (
          <ul className="admin-lookup">
            {runs.resource.value.runs.map((run) => {
              const inspection = inspections.get(run.id)
              return (
                <li key={run.id} className="admin-lookup__item">
                  <div className="admin-lookup__head">
                    <Link to={`/runs/${run.id}`}>{run.runCode}</Link>
                    <span className="panel__hint">
                      {run.ownerDisplayName} ・ {formatMoment(run.createdAt)}
                    </span>
                    <button
                      type="button"
                      className="button button--flat"
                      disabled={inspecting === run.id}
                      onClick={() => void inspect(run)}
                    >
                      {inspecting === run.id ? '取得中…' : '図の状態を確認'}
                      <span className="visually-hidden">: {run.runCode}</span>
                    </button>
                  </div>
                  {inspection === undefined ? null : inspection.posters.length === 0 ? (
                    <p className="panel__hint">
                      最新リビジョンにポスター図はありません（未生成、またはリビジョン自体がありません）。
                    </p>
                  ) : (
                    <div {...TABLE_SCROLL_PROPS}>
                      <table className="data-table">
                        <caption className="visually-hidden">
                          {run.runCode} の最新リビジョンのポスター図
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">種類</th>
                            <th scope="col">状態</th>
                            <th scope="col">失敗コード</th>
                            <th scope="col">試行回数</th>
                            <th scope="col">レンダラー</th>
                            <th scope="col">作成</th>
                          </tr>
                        </thead>
                        <tbody>
                          {inspection.posters.map((poster) => (
                            <tr key={poster.posterId}>
                              <td>{poster.kind === 'auto' ? '自動' : 'カスタム'}</td>
                              <td>
                                <span
                                  className={`admin-flag admin-flag--${poster.status === 'failed' ? 'bad' : poster.status === 'ready' ? 'good' : 'muted'}`}
                                >
                                  {POSTER_STATUS_LABELS[poster.status] ?? poster.status}
                                </span>
                              </td>
                              <td>{poster.failureCode ?? '—'}</td>
                              <td>{formatCount(poster.attemptCount)}</td>
                              <td>{poster.rendererVersion ?? '—'}</td>
                              <td>{formatMoment(poster.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {inspection !== undefined && inspection.failedPosters.length > 0 ? (
                    <p className="panel__hint">
                      失敗した図が {formatCount(inspection.failedPosters.length)} 件あります。再試行は{' '}
                      <Link to={`/runs/${run.id}`}>この実験の画面</Link>{' '}
                      から行います（再試行には描画仕様が必要で、それはスナップショットから組み立てられます。管理画面は測定データを読み込みません）。
                    </p>
                  ) : null}
                </li>
              )
            })}
            {runs.resource.value.runs.length === 0 ? <li>該当する実験がありません。</li> : null}
          </ul>
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="この画面に表示できない情報">
        <div className="panel__header">
          <h2 className="panel__title">表示できない情報</h2>
        </div>
        <dl className="admin-facts">
          {RENDERER_UNAVAILABLE_FACTS.map((fact) => (
            <div className="admin-facts__row" key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.reason}</dd>
            </div>
          ))}
        </dl>
        <p className="panel__hint">
          コンテナを常時起動させておく設定は用意していません。必要なときだけ起動して短時間で終了するのがこのデプロイの費用設計であり、常時起動はその設計を無効にします。
        </p>
      </section>
    </AdminFrame>
  )
}
