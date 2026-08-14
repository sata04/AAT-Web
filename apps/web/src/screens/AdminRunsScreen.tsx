/**
 * `/admin/runs` — the deployment's experiments, and where its bytes actually are.
 *
 * ## This screen reads the member API on purpose
 *
 * There is no administrative run listing. `docs/cloud-data-model.md` states why: an administrator
 * reads a colleague's work through the ordinary routes, where the read is resolved by one
 * middleware, attributed to an actor and written to the *owner's* audit trail. A second listing
 * under `/admin` would be a second authorization path and a read the owner never sees. So the rows
 * come from `GET /api/v1/workspace/runs`, which needs `workspace:read`, and the totals come from
 * `GET /api/v1/admin/storage`, which returns sizes and counts and never a byte of measurement.
 *
 * ## Nothing here loads an object
 *
 * A run's snapshot and poster state are facts about other tables, so they cost one request per run.
 * The screen therefore never fetches them for rows nobody asked about: inspection is per row, or
 * for the runs currently on screen, capped at the page size and three at a time. The alternative —
 * inspecting everything as it arrives — turns opening an admin screen into a request storm
 * proportional to the size of the deployment, which is precisely what a console watching for
 * excessive load should not be.
 *
 * ## Two honest labels this screen must carry
 *
 *  - **Per-user storage is charged to the run's owner, not to whoever caused it.** A colleague can
 *    render a poster from your revision, and that PNG is keyed, indexed and charged under *your*
 *    account — deliberately, because deletion is otherwise incoherent. An operator reading a large
 *    number next to somebody's name without that context would draw the wrong conclusion about who
 *    is consuming the deployment.
 *  - **"Has an original CSV backup" cannot be answered.** The only route that touches a source
 *    backup streams the CSV, so asking the question would mean downloading raw measurement data
 *    into an admin console to render a yes/no. That is a backend gap, and it is stated rather than
 *    approximated.
 */

import { hasCapability } from '@aat/shared'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { listAllAdminUsers, listWorkspaceRuns, type WorkspaceRunSummary } from '../admin/api.ts'
import { formatBytes, formatCount, roleLabel } from '../admin/format.ts'
import { summariseStorage } from '../admin/overview.ts'
import { type AdminResource, LOADING, resourceOf } from '../admin/resource.ts'
import {
  ADMIN_RUN_LIMIT,
  type AdminRunFilter,
  adminRunQueryFor,
  EMPTY_ADMIN_RUN_FILTER,
  inspectRun,
  isEmptyAdminRunFilter,
  matchesInspection,
  needsInspection,
  POSTER_STATE_LABELS,
  pageCount,
  pageOf,
  type RunInspection,
  STORAGE_PAGE_SIZE,
} from '../admin/runs.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import { recordIdLabel } from '../admin/users.ts'
import { fetchStorageReport } from '../cloud/gateway.ts'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

/** How many inspections run at once. The same three the run gallery uses, for the same reason. */
const INSPECT_CONCURRENCY = 3

export function AdminRunsScreen(): React.JSX.Element {
  const session = useSession()
  const canReadWorkspace = hasCapability(session.capabilities, 'workspace:read')
  const canManageQuota = hasCapability(session.capabilities, 'quota:manage')
  const canManageUsers = hasCapability(session.capabilities, 'user:manage')

  const [draft, setDraft] = useState<AdminRunFilter>(EMPTY_ADMIN_RUN_FILTER)
  const [filter, setFilter] = useState<AdminRunFilter>(EMPTY_ADMIN_RUN_FILTER)
  const [runs, setRuns] = useState<readonly WorkspaceRunSummary[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [listState, setListState] = useState<AdminResource<null>>(LOADING)
  const [inspections, setInspections] = useState<ReadonlyMap<string, RunInspection>>(new Map())
  const [inspecting, setInspecting] = useState<ReadonlySet<string>>(new Set())
  const [storagePage, setStoragePage] = useState(0)
  const mounted = useRef(true)
  const ownerFieldId = useId()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const users = useAdminResource(
    useCallback(() => listAllAdminUsers(), []),
    'users',
    canManageUsers,
  )
  const storage = useAdminResource(
    useCallback(() => fetchStorageReport(), []),
    'storage',
    canManageQuota,
  )

  const load = useCallback(async (target: AdminRunFilter, from: string | null) => {
    setListState(LOADING)
    const outcome = await listWorkspaceRuns(adminRunQueryFor(target, from))
    if (!mounted.current) return
    if (!outcome.ok) {
      setListState(resourceOf(outcome))
      return
    }
    setListState({ kind: 'ready', value: null })
    setCursor(outcome.value.nextCursor)
    setRuns((current) =>
      from === null ? outcome.value.runs : [...current, ...outcome.value.runs].slice(0, ADMIN_RUN_LIMIT),
    )
  }, [])

  useEffect(() => {
    if (!canReadWorkspace) return
    setRuns([])
    setCursor(null)
    void load(filter, null)
  }, [filter, canReadWorkspace, load])

  /**
   * Inspect a bounded set of runs, three at a time.
   *
   * The queue is deliberately explicit rather than `Promise.all` over the page: fifty runs is a
   * hundred requests, and firing them together is how a console becomes the reason the Worker is
   * rate-limiting researchers.
   */
  const inspectMany = useCallback(
    async (targets: readonly WorkspaceRunSummary[]) => {
      const queue = targets.map((run) => run.id).filter((id) => !inspections.has(id))
      if (queue.length === 0) return
      setInspecting((current) => new Set([...current, ...queue]))

      let next = 0
      const worker = async () => {
        while (next < queue.length) {
          const id = queue[next]
          next += 1
          if (id === undefined) return
          const outcome = await inspectRun(id)
          if (!mounted.current) return
          if (outcome.ok) {
            const value = outcome.value
            setInspections((current) => new Map(current).set(id, value))
          }
          setInspecting((current) => {
            const remaining = new Set(current)
            remaining.delete(id)
            return remaining
          })
        }
      }
      await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, queue.length) }, worker))
    },
    [inspections],
  )

  const visible = runs.filter((run) => matchesInspection(inspections.get(run.id), filter) !== false)
  const unknownCount = needsInspection(filter)
    ? runs.filter((run) => matchesInspection(inspections.get(run.id), filter) === 'unknown').length
    : 0

  const report = storage.resource.kind === 'ready' ? storage.resource.value : null
  const summary = report === null ? null : summariseStorage(report)
  const perUser =
    report === null ? [] : [...report.perUser].sort((left, right) => right.bytesUsed - left.bytesUsed)
  const storagePages = pageCount(perUser.length, STORAGE_PAGE_SIZE)
  const storageRows = pageOf(perUser, Math.min(storagePage, storagePages - 1), STORAGE_PAGE_SIZE)

  return (
    <AdminFrame
      title="実験と保存容量"
      description="デプロイ全体の実験と、保存容量の内訳です。実験の一覧はメンバー用のチーム一覧APIを使うため、閲覧は所有者の監査ログに記録されます。この画面はスナップショットやポスターの中身を読み込みません。"
    >
      <section className="panel panel--framed" aria-label="保存容量の合計">
        <div className="panel__header">
          <h2 className="panel__title">保存容量の合計</h2>
        </div>
        {!canManageQuota ? <AdminCapabilityNotice capability="quota:manage" /> : null}
        <AdminResourceNotice
          resource={storage.resource}
          label="保存容量の集計"
          enabled={canManageQuota}
          onRetry={storage.reload}
        />
        {summary === null ? null : (
          <dl className="admin-facts admin-facts--grid">
            <div className="admin-facts__row">
              <dt>実験（run）</dt>
              <dd>{formatCount(summary.runs)} 件</dd>
            </div>
            <div className="admin-facts__row">
              <dt>解析リビジョン</dt>
              <dd>{formatCount(summary.revisions)} 件</dd>
            </div>
            <div className="admin-facts__row">
              <dt>保存オブジェクト</dt>
              <dd>{formatCount(summary.totalObjects)} 個</dd>
            </div>
            <div className="admin-facts__row">
              <dt>合計バイト数</dt>
              <dd>{formatBytes(summary.totalBytes)}</dd>
            </div>
            <div className="admin-facts__row">
              <dt>利用者に計上済み</dt>
              <dd>{formatBytes(summary.accountedBytes)}</dd>
            </div>
            <div className="admin-facts__row">
              <dt>未計上の差分</dt>
              <dd>
                {summary.unaccountedBytes === 0
                  ? 'なし'
                  : `${formatBytes(Math.abs(summary.unaccountedBytes))}（確定処理が完了しなかったアップロードの兆候）`}
              </dd>
            </div>
          </dl>
        )}
        <p className="panel__hint">
          種別（スナップショット／ポスター／元CSV）ごとの内訳を返すAPIはありません。合計は cloud_objects
          の非削除行の合計です。
        </p>
      </section>

      <section className="panel panel--framed" aria-label="利用者ごとの保存容量">
        <div className="panel__header">
          <h2 className="panel__title">利用者ごとの保存容量</h2>
          <span className="panel__hint">{report === null ? '' : `${formatCount(perUser.length)} 人`}</span>
        </div>
        {/* The label the shared-workspace policy makes necessary. Without it a large number next to
            a name reads as "this person uploaded all of this", which is not what it means. */}
        <p className="panel__hint">
          保存容量は「実験の所有者」に計上されます。共有ワークスペースでは、他のメンバーが所有者の実験からポスター図を生成することがあり、そのバイト数も所有者の使用量に含まれます。誰が生成したかは監査ログに記録されます。
        </p>
        {report === null ? null : (
          <>
            <div {...TABLE_SCROLL_PROPS}>
              <table className="data-table">
                <caption className="visually-hidden">
                  利用者ごとの使用量、予約量、上限、オブジェクト数
                </caption>
                <thead>
                  <tr>
                    <th scope="col">表示名</th>
                    <th scope="col">権限</th>
                    <th scope="col" className="numeric">
                      使用量
                    </th>
                    <th scope="col" className="numeric">
                      予約中
                    </th>
                    <th scope="col" className="numeric">
                      上限
                    </th>
                    <th scope="col" className="numeric">
                      オブジェクト
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {storageRows.map((row) => (
                    <tr key={row.userId}>
                      <th scope="row">
                        <span>{row.displayName}</span>
                        <span className="panel__hint">{recordIdLabel(row.userId)}</span>
                      </th>
                      <td>{roleLabel(row.role)}</td>
                      <td className="numeric">{formatBytes(row.bytesUsed)}</td>
                      <td className="numeric">
                        {row.bytesReserved === 0 ? '—' : formatBytes(row.bytesReserved)}
                      </td>
                      <td className="numeric">{formatBytes(row.bytesLimit)}</td>
                      <td className="numeric">{formatCount(row.objectCount)}</td>
                    </tr>
                  ))}
                  {storageRows.length === 0 ? (
                    <tr>
                      <td colSpan={6}>保存容量が記録された利用者はいません。</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="screen__actions">
              <button
                type="button"
                className="button button--flat"
                disabled={storagePage === 0}
                onClick={() => setStoragePage((page) => Math.max(0, page - 1))}
              >
                前のページ
              </button>
              <span className="panel__hint" role="status">
                {storagePage + 1} / {storagePages} ページ
              </span>
              <button
                type="button"
                className="button button--flat"
                disabled={storagePage + 1 >= storagePages}
                onClick={() => setStoragePage((page) => Math.min(storagePages - 1, page + 1))}
              >
                次のページ
              </button>
            </div>
            {summary?.perUserTruncated === true ? (
              <p className="panel__hint">
                この集計は使用量の多い上位200件までです。それ以外の利用者は含まれていません。
              </p>
            ) : null}
          </>
        )}
      </section>

      <section className="panel panel--framed" aria-label="実験の検索">
        <div className="panel__header">
          <h2 className="panel__title">実験</h2>
          <span className="panel__hint">
            {listState.kind === 'ready' ? `${formatCount(visible.length)} 件を表示` : ''}
          </span>
        </div>

        {!canReadWorkspace ? <AdminCapabilityNotice capability="workspace:read" /> : null}

        <search aria-label="実験の絞り込み">
          <form
            className="run-filter"
            onSubmit={(event) => {
              event.preventDefault()
              setFilter(draft)
            }}
          >
            <div className="run-filter__fields">
              <label className="field">
                <span className="field__label">実験コード・ファイル名</span>
                <input
                  className="input"
                  type="search"
                  maxLength={128}
                  value={draft.search}
                  onChange={(event) => setDraft({ ...draft, search: event.target.value })}
                />
                <span className="panel__hint">サーバー側で全件から検索します。</span>
              </label>
              <label className="field">
                <span className="field__label">タグ（完全一致）</span>
                <input
                  className="input"
                  type="text"
                  maxLength={64}
                  value={draft.tag}
                  onChange={(event) => setDraft({ ...draft, tag: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label">実験日（開始）</span>
                <input
                  className="input"
                  type="date"
                  value={draft.from}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label">実験日（終了）</span>
                <input
                  className="input"
                  type="date"
                  value={draft.to}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              </label>
              {/* Explicitly associated rather than wrapping, because the control this label names
                  is one of two: a member picker when the user list loaded, and a plain id field
                  when it did not (an operator may hold `quota:manage` without `user:manage`). The
                  label text is the same either way and must stay attached to whichever renders. */}
              <div className="field">
                <label className="field__label" htmlFor={ownerFieldId}>
                  所有者
                </label>
                {users.resource.kind === 'ready' ? (
                  <select
                    id={ownerFieldId}
                    className="select"
                    value={draft.ownerUserId}
                    onChange={(event) => setDraft({ ...draft, ownerUserId: event.target.value })}
                  >
                    <option value="">すべてのメンバー</option>
                    {users.resource.value.users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={ownerFieldId}
                    className="input"
                    type="text"
                    maxLength={64}
                    placeholder="内部ID"
                    value={draft.ownerUserId}
                    onChange={(event) => setDraft({ ...draft, ownerUserId: event.target.value })}
                  />
                )}
              </div>
              <label className="field">
                <span className="field__label">スナップショット</span>
                <select
                  className="select"
                  value={draft.snapshot}
                  onChange={(event) =>
                    setDraft({ ...draft, snapshot: event.target.value as AdminRunFilter['snapshot'] })
                  }
                >
                  <option value="any">すべて</option>
                  <option value="yes">あり</option>
                  <option value="no">なし</option>
                </select>
              </label>
              <label className="field">
                <span className="field__label">ポスター図</span>
                <select
                  className="select"
                  value={draft.poster}
                  onChange={(event) =>
                    setDraft({ ...draft, poster: event.target.value as AdminRunFilter['poster'] })
                  }
                >
                  <option value="any">すべて</option>
                  <option value="ready">生成済み</option>
                  <option value="rendering">生成中</option>
                  <option value="failed">失敗あり</option>
                  <option value="none">未生成</option>
                </select>
              </label>
            </div>
            <div className="screen__actions">
              <button type="submit" className="button button--primary">
                絞り込む
              </button>
              <button
                type="button"
                className="button button--flat"
                onClick={() => {
                  setDraft(EMPTY_ADMIN_RUN_FILTER)
                  setFilter(EMPTY_ADMIN_RUN_FILTER)
                }}
              >
                条件を消す
              </button>
              <button
                type="button"
                className="button button--flat"
                disabled={runs.length === 0}
                onClick={() => void inspectMany(runs)}
              >
                表示中の実験の詳細を取得
              </button>
            </div>
            <p className="panel__hint">
              実験コード・タグ・日付・所有者はサーバー側の絞り込みです。スナップショットとポスター図の状態はサーバー側で絞り込めないため、詳細を取得した実験にだけ適用されます。
            </p>
          </form>
        </search>

        <AdminResourceNotice
          resource={listState}
          label="実験の一覧"
          enabled={canReadWorkspace}
          onRetry={() => void load(filter, null)}
        />

        {unknownCount > 0 ? (
          <p className="notice notice--warning" role="status">
            <span className="notice__body">
              {formatCount(unknownCount)}{' '}
              件は詳細が未取得のため、状態による絞り込みの対象外として表示しています。
            </span>
          </p>
        ) : null}

        <div {...TABLE_SCROLL_PROPS}>
          <table className="data-table">
            <caption className="visually-hidden">
              実験、所有者、リビジョン数、スナップショットとポスターの状態
            </caption>
            <thead>
              <tr>
                <th scope="col">実験コード</th>
                <th scope="col">所有者</th>
                <th scope="col">実験日</th>
                <th scope="col">ファイル名</th>
                <th scope="col">リビジョン</th>
                <th scope="col">スナップショット</th>
                <th scope="col">ポスター図</th>
                <th scope="col">
                  <span className="visually-hidden">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((run) => {
                const inspection = inspections.get(run.id)
                const busy = inspecting.has(run.id)
                return (
                  <tr key={run.id}>
                    <th scope="row">
                      <Link to={`/runs/${run.id}`}>{run.runCode}</Link>
                    </th>
                    <td>
                      <span>{run.ownerDisplayName}</span>
                      <span className="panel__hint">{recordIdLabel(run.ownerUserId)}</span>
                    </td>
                    <td>{run.experimentDate ?? '日付なし'}</td>
                    <td>{run.originalFilename}</td>
                    <td>{inspection === undefined ? '—' : formatCount(inspection.revisionCount)}</td>
                    <td>{inspection === undefined ? '未取得' : inspection.hasSnapshot ? 'あり' : 'なし'}</td>
                    <td>
                      {inspection === undefined ? '未取得' : POSTER_STATE_LABELS[inspection.posterState]}
                    </td>
                    <td>
                      {inspection === undefined ? (
                        <button
                          type="button"
                          className="button button--flat"
                          disabled={busy}
                          onClick={() => void inspectMany([run])}
                        >
                          {busy ? '取得中…' : '詳細を取得'}
                          <span className="visually-hidden">: {run.runCode}</span>
                        </button>
                      ) : (
                        <span className="panel__hint">取得済み</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {listState.kind === 'ready' && visible.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    {isEmptyAdminRunFilter(filter)
                      ? 'このデプロイにはまだ実験が保存されていません。'
                      : '条件に一致する実験はありません。'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="screen__actions">
          {cursor === null ? (
            <span className="panel__hint">これ以上の実験はありません。</span>
          ) : runs.length >= ADMIN_RUN_LIMIT ? (
            <span className="panel__hint">
              表示できる上限（{formatCount(ADMIN_RUN_LIMIT)} 件）に達しました。条件を絞り込んでください。
            </span>
          ) : (
            <button
              type="button"
              className="button button--flat"
              disabled={listState.kind === 'loading'}
              onClick={() => void load(filter, cursor)}
            >
              さらに読み込む
            </button>
          )}
        </div>

        <p className="panel__hint">
          元CSVのバックアップの有無は表示できません。バックアップに触れるAPIはCSVそのものを返す経路だけで、有無を確かめるために測定データを管理画面に取り込むことになるためです（メタデータAPIがあれば1行で答えられます）。
        </p>
      </section>

      <p className="panel__hint">
        実験の詳細・スナップショットの再表示・ポスター図は <Link to="/runs">実験一覧</Link>{' '}
        から開きます。管理画面は測定データを読み込みません。
      </p>
    </AdminFrame>
  )
}
