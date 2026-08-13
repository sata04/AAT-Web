/**
 * `/admin` — what is in this deployment and what has been happening in it.
 *
 * An overview is the easiest screen in an admin console to get wrong, because the temptation is to
 * make it *look* like a control room. This one is built from a single rule: **every figure on it is
 * a fact an operator can act on, and every figure a reader would expect but cannot be given is
 * named as missing.** Both halves matter. A screen that quietly omits "how many renders failed"
 * looks exactly like a screen reporting that none did.
 *
 * Five endpoints, three capabilities, and each section degrades on its own rather than the screen
 * refusing wholesale — `user:manage`, `quota:manage` and `audit:read` are separate grants and a
 * deployment may well have given an operator one of them. `AdminCapabilityNotice` says which is
 * missing rather than leaving a blank where a number was.
 *
 * The one graphical element is the storage meter on the heaviest accounts, and it is here for the
 * reason given in `AdminQuotaMeter`: a proportion is the one thing a number reads badly. There is
 * no chart of users over time, no sparkline of renders, and no ring of storage by type — the last
 * of those because the API cannot break storage down by type at all, so the chart would be a
 * drawing of a number this console does not have.
 */

import { hasCapability } from '@aat/shared'
import { useCallback } from 'react'
import { listAuditEntries } from '../admin/api.ts'
import { auditActionLabel } from '../admin/audit.ts'
import { formatBytes, formatCount, formatInstant, roleLabel } from '../admin/format.ts'
import { countLiveInvitations } from '../admin/invitations.ts'
import {
  countCrossUser,
  posterActivity,
  recentNotable,
  summariseStorage,
  UNAVAILABLE_METRICS,
} from '../admin/overview.ts'
import { presentBreaker } from '../admin/renderer.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import { countByRole, countDisabled, mergeAdminUsers, recordIdLabel } from '../admin/users.ts'
import {
  fetchRendererBreaker,
  fetchStorageReport,
  listAdminUsers,
  listInvitations,
} from '../cloud/gateway.ts'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminQuotaMeter } from '../components/AdminQuotaMeter.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

/** How much of the audit log the overview reads. One page: enough to characterise, cheap to fetch. */
const AUDIT_SAMPLE = 50

/** How many notable entries the front page shows before sending the reader to the log itself. */
const NOTABLE_LIMIT = 8

/** How many accounts get a meter. The question is "who is close to their ceiling", not a ranking. */
const TOP_CONSUMERS = 5

export function AdminOverviewScreen(): React.JSX.Element {
  const session = useSession()
  const canManageUsers = hasCapability(session.capabilities, 'user:manage')
  const canManageQuota = hasCapability(session.capabilities, 'quota:manage')
  const canReadAudit = hasCapability(session.capabilities, 'audit:read')
  const canManageInvitations = hasCapability(session.capabilities, 'invitation:manage')

  const users = useAdminResource(
    useCallback(() => listAdminUsers({ limit: 200 }), []),
    'users',
    canManageUsers,
  )
  const storage = useAdminResource(
    useCallback(() => fetchStorageReport(), []),
    'storage',
    canManageQuota,
  )
  const audit = useAdminResource(
    useCallback(() => listAuditEntries({ limit: AUDIT_SAMPLE }), []),
    'audit',
    canReadAudit,
  )
  const invitations = useAdminResource(
    useCallback(() => listInvitations({ limit: 200 }), []),
    'invitations',
    canManageInvitations,
  )
  const renderer = useAdminResource(
    useCallback(() => fetchRendererBreaker(), []),
    'renderer',
    canManageQuota,
  )

  const userRows =
    users.resource.kind === 'ready' && storage.resource.kind === 'ready'
      ? mergeAdminUsers(users.resource.value.users, storage.resource.value.perUser)
      : users.resource.kind === 'ready'
        ? mergeAdminUsers(users.resource.value.users, [])
        : []
  const roleCounts = countByRole(userRows)
  const summary = storage.resource.kind === 'ready' ? summariseStorage(storage.resource.value) : null
  const entries = audit.resource.kind === 'ready' ? audit.resource.value.entries : []
  const activity = posterActivity(entries)
  const notable = recentNotable(entries, NOTABLE_LIMIT)
  const crossUser = countCrossUser(entries)

  const topConsumers =
    storage.resource.kind === 'ready'
      ? [...storage.resource.value.perUser]
          .sort((left, right) => right.bytesUsed - left.bytesUsed)
          .slice(0, TOP_CONSUMERS)
      : []

  return (
    <AdminFrame
      title="管理"
      description="このデプロイの利用者・保存容量・ポスター生成・監査ログの現況です。数値はすべて管理APIが返した実測値で、算出できない指標は最後に理由付きで列挙します。"
    >
      <section className="panel panel--framed" aria-label="デプロイの概要">
        <div className="panel__header">
          <h2 className="panel__title">デプロイの概要</h2>
        </div>

        {!canManageUsers && !canManageQuota ? (
          <AdminCapabilityNotice capability="user:manage / quota:manage" />
        ) : null}

        <AdminResourceNotice
          resource={users.resource}
          label="利用者一覧"
          enabled={canManageUsers}
          onRetry={users.reload}
        />
        <AdminResourceNotice
          resource={storage.resource}
          label="保存容量の集計"
          enabled={canManageQuota}
          onRetry={storage.reload}
        />

        <dl className="admin-facts admin-facts--grid">
          {canManageUsers ? (
            <>
              <div className="admin-facts__row">
                <dt>利用者</dt>
                <dd>{users.resource.kind === 'ready' ? `${formatCount(userRows.length)} 人` : '—'}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>有効 / 停止</dt>
                <dd>
                  {users.resource.kind === 'ready'
                    ? `${formatCount(userRows.length - countDisabled(userRows))} 人 / ${formatCount(countDisabled(userRows))} 人`
                    : '—'}
                </dd>
              </div>
              <div className="admin-facts__row">
                <dt>権限の内訳</dt>
                <dd>
                  {users.resource.kind === 'ready'
                    ? [...roleCounts.entries()]
                        .map(([role, count]) => `${roleLabel(role)} ${formatCount(count)}`)
                        .join(' / ') || '—'
                    : '—'}
                </dd>
              </div>
            </>
          ) : null}

          {canManageQuota ? (
            <>
              <div className="admin-facts__row">
                <dt>実験（run）</dt>
                <dd>{summary === null ? '—' : `${formatCount(summary.runs)} 件`}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>解析リビジョン</dt>
                <dd>{summary === null ? '—' : `${formatCount(summary.revisions)} 件`}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>保存オブジェクト</dt>
                <dd>{summary === null ? '—' : `${formatCount(summary.totalObjects)} 個`}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>合計保存容量</dt>
                <dd>{summary === null ? '—' : formatBytes(summary.totalBytes)}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>利用者に計上済み</dt>
                <dd>{summary === null ? '—' : formatBytes(summary.accountedBytes)}</dd>
              </div>
              <div className="admin-facts__row">
                <dt>予約中（アップロード進行中）</dt>
                <dd>{summary === null ? '—' : formatBytes(summary.reservedBytes)}</dd>
              </div>
              {/* Not averaged away and not hidden: a gap between the object sum and the quota sum is
                  the exact symptom of a finalise that did not complete. */}
              <div className="admin-facts__row">
                <dt>未計上の差分</dt>
                <dd>
                  {summary === null
                    ? '—'
                    : summary.unaccountedBytes === 0
                      ? 'なし'
                      : `${formatBytes(Math.abs(summary.unaccountedBytes))}（cloud_objects と quota_usage の差。確定処理が完了しなかったアップロードの兆候です）`}
                </dd>
              </div>
            </>
          ) : null}

          {canManageInvitations ? (
            <div className="admin-facts__row">
              <dt>有効な招待</dt>
              <dd>
                {invitations.resource.kind === 'ready'
                  ? `${formatCount(countLiveInvitations(invitations.resource.value.invitations))} 件（未使用・受理中）`
                  : '—'}
              </dd>
            </div>
          ) : null}

          {canManageQuota ? (
            <div className="admin-facts__row">
              <dt>ポスターレンダラー</dt>
              <dd>
                {renderer.resource.kind === 'ready'
                  ? presentBreaker(renderer.resource.value.circuitBreaker).label
                  : '—'}
              </dd>
            </div>
          ) : null}
        </dl>

        {summary?.perUserTruncated === true ? (
          <p className="panel__hint">
            利用者ごとの保存容量は上位200件までの集計です。合計値はデプロイ全体の値ですが、内訳は途中で切れている可能性があります。
          </p>
        ) : null}
      </section>

      {canManageQuota ? (
        <section className="panel panel--framed" aria-label="保存容量の多いアカウント">
          <div className="panel__header">
            <h2 className="panel__title">保存容量の多いアカウント</h2>
            <span className="panel__hint">上限に近いアカウントは、次のアップロードから失敗します。</span>
          </div>
          <AdminResourceNotice resource={storage.resource} label="保存容量の集計" onRetry={storage.reload} />
          {storage.resource.kind === 'ready' ? (
            topConsumers.length === 0 ? (
              <p className="panel__hint">まだ保存されたオブジェクトはありません。</p>
            ) : (
              <ul className="admin-consumers">
                {topConsumers.map((row) => (
                  <li key={row.userId} className="admin-consumers__item">
                    <span className="admin-consumers__name">{row.displayName}</span>
                    <span className="panel__hint">{recordIdLabel(row.userId)}</span>
                    <AdminQuotaMeter
                      label={row.displayName}
                      used={row.bytesUsed}
                      reserved={row.bytesReserved}
                      limit={row.bytesLimit}
                    />
                  </li>
                ))}
              </ul>
            )
          ) : null}
          <p className="panel__hint">
            共有ワークスペースでは、ある利用者の保存量に他のメンバーが生成させたバイト数が含まれることがあります（ポスター図は実験の所有者に計上されます）。
            <Link to="/admin/runs">実験と保存容量</Link> で内訳を確認できます。
          </p>
        </section>
      ) : null}

      <section className="panel panel--framed" aria-label="ポスター生成の状況">
        <div className="panel__header">
          <h2 className="panel__title">ポスター生成の状況</h2>
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
                <dd>{formatCount(activity.rendered)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>再試行</dt>
                <dd>{formatCount(activity.retried)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>図の取得</dt>
                <dd>{formatCount(activity.downloaded)} 件</dd>
              </div>
              <div className="admin-facts__row">
                <dt>他メンバーの作業への操作</dt>
                <dd>{formatCount(crossUser)} 件</dd>
              </div>
            </dl>
            {/* The denominator, always. Without it these are four numbers with no unit of time. */}
            <p className="panel__hint">
              直近 {formatCount(activity.sampled)} 件の監査ログに含まれる件数です（最も古い記録:{' '}
              {formatInstant(activity.oldest)}
              ）。期間あたりの件数ではありません。失敗したレンダリングは監査ログに記録されないため、失敗件数はここには現れません。
            </p>
          </>
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="最近の重要な操作">
        <div className="panel__header">
          <h2 className="panel__title">最近の重要な操作</h2>
          <Link to="/admin/audit" className="button button--flat">
            監査ログをすべて見る
          </Link>
        </div>
        {!canReadAudit ? <AdminCapabilityNotice capability="audit:read" /> : null}
        <AdminResourceNotice
          resource={audit.resource}
          label="監査ログ"
          enabled={canReadAudit}
          onRetry={audit.reload}
        />
        {audit.resource.kind === 'ready' ? (
          <div className="table-scroll">
            <table className="data-table">
              <caption className="visually-hidden">
                権限・停止・削除・招待・容量など、デプロイの状態を変える操作の直近の記録
              </caption>
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  <th scope="col">操作</th>
                  <th scope="col">実行者</th>
                  <th scope="col">対象</th>
                </tr>
              </thead>
              <tbody>
                {notable.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatInstant(entry.createdAt)}</td>
                    <td>{auditActionLabel(entry.action)}</td>
                    <td>{entry.actorUserId === null ? '—' : recordIdLabel(entry.actorUserId)}</td>
                    <td>
                      {entry.targetId === null ? '—' : `${entry.targetType ?? ''} ${entry.targetId}`.trim()}
                    </td>
                  </tr>
                ))}
                {notable.length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      直近 {formatCount(entries.length)}{' '}
                      件の記録に、権限・停止・削除・招待・容量に関わる操作はありません。
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="panel panel--framed" aria-label="この画面に表示できない指標">
        <div className="panel__header">
          <h2 className="panel__title">表示できない指標</h2>
        </div>
        <p className="panel__hint">
          運用上ほしくなる数値のうち、現在のAPIでは算出できないものです。省略すると「ゼロ件」と区別がつかないため、理由とともに列挙します。
        </p>
        <dl className="admin-facts">
          {UNAVAILABLE_METRICS.map((metric) => (
            <div className="admin-facts__row" key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.reason}</dd>
            </div>
          ))}
        </dl>
      </section>
    </AdminFrame>
  )
}
