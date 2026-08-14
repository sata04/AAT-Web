/**
 * `/admin/users` — who is in this deployment, and the six things that can be done to an account.
 *
 * ## The display name is the identity, and there is nothing else
 *
 * There is no email address in AAT. `worker/auth/identity.ts` mints a synthetic `@aat.invalid`
 * address because the auth framework's data model demands a unique one; no route returns it, and
 * this screen would be exactly where it started being mistaken for a way to reach a person. So the
 * only two identifiers here are the display name — the human identity — and the opaque record id,
 * which is always rendered through `recordIdLabel` so it reads as 内部ID and never as an address.
 *
 * ## A table of six columns and a detail panel, not a table of twelve
 *
 * Role, status, storage and passkeys are four different questions, and the actions on them are
 * destructive in four different ways. A row wide enough to hold all of them is a row nobody reads
 * before clicking, so the table answers "who is here and who needs attention" and the actions live
 * in a panel that names the account it is acting on in every sentence.
 *
 * ## What this screen does not offer, and why
 *
 *  - **Session revocation as a separate button.** 停止 already is one: banning deletes the
 *    account's session rows, `requireSession` refuses a banned user on every subsequent request,
 *    and the passkey seam refuses before a new cookie is ever issued. Starting a recovery revokes
 *    them too, because recovering an account whose old sessions are still live has recovered
 *    nothing. A third control that did the same thing under a different name would only invite the
 *    question of which one really worked.
 *  - **A separate "disable" and "ban".** The backend has one boolean and one reason string. Two
 *    controls over one column would be an invented distinction that the audit log — which records
 *    `user.ban` / `user.unban` — could not tell apart.
 */

import { hasCapability, ROLES, type Role } from '@aat/shared'
import { useCallback, useState } from 'react'
import { countRunsForOwner, listAllAdminUsers } from '../admin/api.ts'
import {
  formatBytes,
  formatCount,
  formatMoment,
  type QuotaUnit,
  quotaAmountOf,
  quotaBytesFrom,
  quotaPressure,
  roleLabel,
} from '../admin/format.ts'
import { DEFAULT_INVITATION_TTL_HOURS, invitationUrl } from '../admin/invitations.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import {
  type AdminUserRow,
  type AdminUserSort,
  countDisabled,
  filterAdminUsers,
  lastPasskeyUse,
  mergeAdminUsers,
  recordIdLabel,
  sortAdminUsers,
} from '../admin/users.ts'
import {
  type AdminPasskey,
  createInvitation,
  deleteAdminPasskey,
  deleteAdminUser,
  fetchStorageReport,
  listAdminUserPasskeys,
  setUserQuota,
  updateAdminUser,
} from '../cloud/gateway.ts'
import { AdminConfirmDialog } from '../components/AdminConfirmDialog.tsx'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminOneTimeSecret } from '../components/AdminOneTimeSecret.tsx'
import { AdminQuotaMeter } from '../components/AdminQuotaMeter.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { Dialog } from '../components/Dialog.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { useSession } from '../session/SessionProvider.tsx'

interface Notice {
  tone: 'info' | 'error'
  text: string
}

/** A pending action that needs a confirmation before it is sent. */
type Pending =
  | { kind: 'role'; user: AdminUserRow; role: Role }
  | { kind: 'ban'; user: AdminUserRow; reason: string }
  | { kind: 'unban'; user: AdminUserRow }
  | { kind: 'delete'; user: AdminUserRow }
  | { kind: 'passkey'; user: AdminUserRow; passkey: AdminPasskey }

export function AdminUsersScreen(): React.JSX.Element {
  const session = useSession()
  const canManageUsers = hasCapability(session.capabilities, 'user:manage')
  const canManageQuota = hasCapability(session.capabilities, 'quota:manage')
  const canInvite = hasCapability(session.capabilities, 'invitation:manage')

  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<AdminUserSort>('storage')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ displayName: string; url: string } | null>(null)

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

  const reloadAll = () => {
    users.reload()
    storage.reload()
  }

  const rows =
    users.resource.kind === 'ready'
      ? sortAdminUsers(
          filterAdminUsers(
            mergeAdminUsers(
              users.resource.value.users,
              storage.resource.kind === 'ready' ? storage.resource.value.perUser : [],
            ),
            search,
          ),
          sort,
        )
      : []
  const selected = rows.find((row) => row.id === selectedId) ?? null

  const send = async (action: () => Promise<{ ok: boolean; message?: string }>, success: string) => {
    setBusy(true)
    const outcome = await action()
    setBusy(false)
    if (!outcome.ok) {
      setNotice({ tone: 'error', text: outcome.message ?? '操作できませんでした。' })
      return false
    }
    setNotice({ tone: 'info', text: success })
    setPending(null)
    reloadAll()
    return true
  }

  const confirmPending = async () => {
    if (pending === null) return
    if (pending.kind === 'role') {
      await send(
        () => updateAdminUser(pending.user.id, { role: pending.role }),
        `${pending.user.displayName} の権限を ${roleLabel(pending.role)} に変更しました。`,
      )
      return
    }
    if (pending.kind === 'ban') {
      await send(
        () =>
          updateAdminUser(pending.user.id, {
            banned: true,
            banReason: pending.reason.trim() === '' ? null : pending.reason.trim(),
          }),
        `${pending.user.displayName} のアカウントを停止しました。既存のセッションは次の要求で拒否されます。`,
      )
      return
    }
    if (pending.kind === 'unban') {
      await send(
        () => updateAdminUser(pending.user.id, { banned: false }),
        `${pending.user.displayName} の停止を解除しました。`,
      )
      return
    }
    if (pending.kind === 'passkey') {
      await send(
        () => deleteAdminPasskey(pending.passkey.id),
        `${pending.user.displayName} のパスキーを1件削除しました。`,
      )
      return
    }
    const removed = await send(
      () => deleteAdminUser(pending.user.id),
      `${pending.user.displayName} のアカウントと保存済みオブジェクトを削除しました。`,
    )
    if (removed) setSelectedId(null)
  }

  return (
    <AdminFrame
      title="利用者"
      description="このデプロイのアカウント、権限、停止状態、保存容量です。連絡先は保持していません。表示名が唯一の人間可読な識別子で、内部IDは監査ログと突き合わせるための記録用の識別子です。"
    >
      {notice === null ? null : (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span className="notice__body">{notice.text}</span>
          <button type="button" className="button button--flat" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      {issued === null ? null : (
        <AdminOneTimeSecret
          title="再登録用URLを発行しました"
          description={`${issued.displayName} 本人にだけ渡してください。このURLを開いた人が、このアカウントに新しいパスキーを登録できます。`}
          url={issued.url}
          onDismiss={() => setIssued(null)}
        />
      )}

      <section className="panel panel--framed" aria-label="利用者の一覧">
        <div className="panel__header">
          <h2 className="panel__title">利用者</h2>
          <span className="panel__hint">
            {users.resource.kind === 'ready'
              ? `${formatCount(rows.length)} 人を表示（停止中 ${formatCount(countDisabled(rows))} 人）`
              : ''}
          </span>
        </div>

        {!canManageUsers ? <AdminCapabilityNotice capability="user:manage" /> : null}
        <AdminResourceNotice
          resource={users.resource}
          label="利用者一覧"
          enabled={canManageUsers}
          onRetry={users.reload}
        />
        {canManageQuota ? (
          <AdminResourceNotice resource={storage.resource} label="保存容量の集計" onRetry={storage.reload} />
        ) : (
          <p className="panel__hint">保存容量の表示には quota:manage の権限が必要です。</p>
        )}

        {users.resource.kind === 'ready' && !users.resource.value.complete ? (
          <p className="notice notice--warning" role="alert">
            <span className="notice__body">
              利用者が多く、取得を途中で打ち切りました。表示されていないアカウントがあります。
            </span>
          </p>
        ) : null}

        <search className="run-filter" aria-label="利用者の絞り込み">
          <div className="run-filter__fields">
            <label className="field">
              <span className="field__label">表示名・内部IDで絞り込む</span>
              <input
                className="input"
                type="search"
                value={search}
                maxLength={128}
                onChange={(event) => setSearch(event.target.value)}
              />
              <span className="panel__hint">
                読み込み済みの一覧に対する絞り込みです（サーバー側の検索APIはありません）。
              </span>
            </label>
            <label className="field">
              <span className="field__label">並び順</span>
              <select
                className="select"
                value={sort}
                onChange={(event) => setSort(event.target.value as AdminUserSort)}
              >
                <option value="storage">保存容量が多い順</option>
                <option value="name">表示名順</option>
                <option value="role">権限順</option>
              </select>
            </label>
          </div>
        </search>

        {users.resource.kind === 'ready' ? (
          <div {...TABLE_SCROLL_PROPS}>
            <table className="data-table">
              <caption className="visually-hidden">利用者、権限、アカウントの状態、保存容量</caption>
              <thead>
                <tr>
                  <th scope="col">表示名</th>
                  <th scope="col">権限</th>
                  <th scope="col">状態</th>
                  <th scope="col">保存容量</th>
                  <th scope="col">上限</th>
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} aria-current={row.id === selectedId ? 'true' : undefined}>
                    <th scope="row" className="admin-users__name">
                      <span>{row.displayName}</span>
                      <span className="panel__hint">{recordIdLabel(row.id)}</span>
                    </th>
                    <td>{roleLabel(row.role)}</td>
                    <td>
                      {/* Words first: 停止 is a security state and must survive a monochrome print. */}
                      <span
                        className={row.banned ? 'admin-flag admin-flag--bad' : 'admin-flag admin-flag--good'}
                      >
                        {row.banned ? '停止' : '有効'}
                      </span>
                    </td>
                    <td>
                      {row.storage === null
                        ? '記録なし'
                        : `${formatBytes(row.storage.bytesUsed)}（${formatCount(row.storage.objectCount)} 個）`}
                    </td>
                    <td>
                      {row.storage === null
                        ? '—'
                        : `${formatBytes(row.storage.bytesLimit)}${row.quotaOverridden ? '（個別設定）' : ''}`}
                      {row.storage === null ? null : (
                        <span className="panel__hint">
                          {
                            quotaPressure(
                              row.storage.bytesUsed,
                              row.storage.bytesReserved,
                              row.storage.bytesLimit,
                            ).label
                          }
                        </span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button--flat"
                        aria-expanded={row.id === selectedId}
                        onClick={() => setSelectedId(row.id === selectedId ? null : row.id)}
                      >
                        {row.id === selectedId ? '閉じる' : '操作'}
                        <span className="visually-hidden">: {row.displayName}</span>
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      {search.trim() === ''
                        ? 'アカウントがありません。'
                        : `「${search}」に一致するアカウントはありません。`}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {selected === null ? null : (
        // Keyed by account: the panel holds per-account state — the role about to be applied, the
        // quota being typed, the passkeys that were loaded — and selecting a different person must
        // not leave any of it behind. A remount is the only way that is guaranteed.
        <UserActions
          key={selected.id}
          user={selected}
          isSelf={selected.id === session.user?.id}
          canManageQuota={canManageQuota}
          canInvite={canInvite}
          busy={busy}
          onRequest={setPending}
          onNotice={setNotice}
          onIssued={setIssued}
          onChanged={reloadAll}
        />
      )}

      {pending === null ? null : pending.kind === 'delete' ? (
        <AdminConfirmDialog
          title="アカウントを完全に削除します"
          description={
            `${pending.user.displayName}（${recordIdLabel(pending.user.id)}）を削除します。\n` +
            'この利用者が所有するR2上のオブジェクト（スナップショット・ポスター図・元CSV）を先に削除し、そのあとで利用者の行を削除します。実験・リビジョン・パスキーの行も外部キーの連鎖で消えます。\n' +
            `削除される保存容量: ${pending.user.storage === null ? '不明' : formatBytes(pending.user.storage.bytesUsed)}（${pending.user.storage === null ? '不明' : formatCount(pending.user.storage.objectCount)} 個）\n` +
            '監査ログの記録は残りますが、そこから参照される実験や図は失われます。元に戻す方法はありません。'
          }
          confirmPhrase={pending.user.displayName}
          confirmLabel="完全に削除する"
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        />
      ) : (
        <Dialog
          title={
            pending.kind === 'role'
              ? '権限を変更します'
              : pending.kind === 'ban'
                ? 'アカウントを停止します'
                : pending.kind === 'unban'
                  ? '停止を解除します'
                  : 'パスキーを削除します'
          }
          description={confirmDescription(pending)}
          onClose={() => setPending(null)}
          footer={
            <>
              <button
                type="button"
                className="button button--flat"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void confirmPending()}
              >
                {busy ? '実行しています…' : '実行する'}
              </button>
            </>
          }
        >
          {pending.kind === 'ban' ? (
            <div className="dialog__section">
              <label className="field">
                <span className="field__label">停止の理由（任意・監査ログとアカウントに残ります）</span>
                <input
                  className="input"
                  type="text"
                  maxLength={500}
                  value={pending.reason}
                  onChange={(event) => setPending({ ...pending, reason: event.target.value })}
                />
              </label>
            </div>
          ) : null}
        </Dialog>
      )}
    </AdminFrame>
  )
}

function confirmDescription(pending: Pending): string {
  if (pending.kind === 'role') {
    return (
      `${pending.user.displayName} の権限を ${roleLabel(pending.user.role)} から ${roleLabel(pending.role)} に変更します。\n` +
      '権限は要求ごとに機能（capability）へ展開されるため、変更は次の要求から有効になります。'
    )
  }
  if (pending.kind === 'ban') {
    return (
      `${pending.user.displayName} のアカウントを停止します。\n` +
      'サインイン中のセッションは次の要求で拒否され、パスキーでのサインインもできなくなります。保存された実験・スナップショット・図は削除されません。\n' +
      'いつでも解除できます。'
    )
  }
  if (pending.kind === 'unban') {
    return `${pending.user.displayName} の停止を解除します。以後、パスキーでサインインできるようになります。`
  }
  return (
    `${pending.user.displayName} のパスキーを1件削除します。\n` +
    'AATにはパスワードもメールもないため、パスキーはアカウントそのものです。最後の1件はサーバーが削除を拒否します。先に再登録用URLを発行してください。'
  )
}

/* ------------------------------------------------------------------------------------------- */
/* The per-account panel                                                                        */
/* ------------------------------------------------------------------------------------------- */

interface UserActionsProps {
  user: AdminUserRow
  isSelf: boolean
  canManageQuota: boolean
  canInvite: boolean
  busy: boolean
  onRequest: (pending: Pending) => void
  onNotice: (notice: Notice) => void
  onIssued: (issued: { displayName: string; url: string }) => void
  onChanged: () => void
}

function UserActions(props: UserActionsProps): React.JSX.Element {
  const [role, setRole] = useState<Role>(
    (ROLES as readonly string[]).includes(props.user.role) ? (props.user.role as Role) : 'Viewer',
  )
  const [passkeys, setPasskeys] = useState<readonly AdminPasskey[] | null>(null)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)
  const [runCount, setRunCount] = useState<string | null>(null)
  const [quotaAmount, setQuotaAmount] = useState(
    props.user.storage === null ? '' : quotaAmountOf(props.user.storage.bytesLimit, 'GiB'),
  )
  const [quotaUnit, setQuotaUnit] = useState<QuotaUnit>('GiB')
  const [working, setWorking] = useState(false)

  const loadPasskeys = async () => {
    setPasskeyError(null)
    const outcome = await listAdminUserPasskeys(props.user.id)
    if (!outcome.ok) {
      setPasskeyError(outcome.message)
      return
    }
    setPasskeys(outcome.value.passkeys)
  }

  const countRuns = async () => {
    setWorking(true)
    const outcome = await countRunsForOwner(props.user.id)
    setWorking(false)
    if (!outcome.ok) {
      props.onNotice({ tone: 'error', text: outcome.message })
      return
    }
    setRunCount(`${outcome.value.count}${outcome.value.truncated ? '+' : ''}`)
  }

  const applyQuota = async () => {
    const bytes = quotaBytesFrom(quotaAmount, quotaUnit)
    if (bytes === null) {
      props.onNotice({ tone: 'error', text: '保存容量の上限には0以上の数値を入力してください。' })
      return
    }
    setWorking(true)
    const outcome = await setUserQuota(props.user.id, bytes)
    setWorking(false)
    if (!outcome.ok) {
      props.onNotice({ tone: 'error', text: outcome.message })
      return
    }
    props.onNotice({
      tone: 'info',
      text: `${props.user.displayName} の保存容量の上限を ${formatBytes(outcome.value.quota.bytesLimit)} にしました。`,
    })
    props.onChanged()
  }

  const issueRecovery = async () => {
    setWorking(true)
    const outcome = await createInvitation({
      kind: 'recovery',
      role,
      displayName: props.user.displayName,
      targetUserId: props.user.id,
      ttlHours: DEFAULT_INVITATION_TTL_HOURS,
      note: 'パスキー再登録（管理画面から発行）',
    })
    setWorking(false)
    if (!outcome.ok) {
      props.onNotice({ tone: 'error', text: outcome.message })
      return
    }
    props.onIssued({
      displayName: props.user.displayName,
      url: invitationUrl(window.location.origin, 'recovery', outcome.value.invitation.token),
    })
  }

  const lastUse = passkeys === null ? null : lastPasskeyUse(passkeys)

  return (
    <section className="panel panel--framed" aria-label={`${props.user.displayName} の操作`}>
      <div className="panel__header">
        <h2 className="panel__title">{props.user.displayName}</h2>
        <span className="panel__hint">{recordIdLabel(props.user.id)}</span>
      </div>

      {props.isSelf ? (
        <p className="notice notice--warning" role="status">
          <span className="notice__body">
            自分のアカウントです。管理者が自分の権限を下げたり自分を停止・削除したりすると、管理者が誰もいないデプロイになり得るため、サーバーが拒否します。
          </span>
        </p>
      ) : null}

      <dl className="admin-facts admin-facts--grid">
        <div className="admin-facts__row">
          <dt>作成日時</dt>
          <dd>{props.user.createdAt === '' ? '—' : formatMoment(props.user.createdAt)}</dd>
        </div>
        <div className="admin-facts__row">
          <dt>状態</dt>
          <dd>{props.user.banned ? '停止中' : '有効'}</dd>
        </div>
        <div className="admin-facts__row">
          <dt>保存容量</dt>
          <dd>
            {props.user.storage === null
              ? '保存容量の記録がありません（まだ何も保存していないか、集計に含まれていません）'
              : `${formatBytes(props.user.storage.bytesUsed)} / ${formatBytes(props.user.storage.bytesLimit)}`}
          </dd>
        </div>
        <div className="admin-facts__row">
          <dt>実験の数</dt>
          <dd>
            {runCount === null ? (
              <button
                type="button"
                className="button button--flat"
                disabled={working}
                onClick={() => void countRuns()}
              >
                数える
              </button>
            ) : (
              `${runCount} 件`
            )}
          </dd>
        </div>
        <div className="admin-facts__row">
          <dt>最終認証</dt>
          <dd>
            {passkeys === null
              ? 'パスキーを読み込むと表示されます'
              : lastUse === null
                ? '記録なし'
                : `${formatMoment(lastUse)}（最後にパスキーで認証した時刻。セッションの最終利用時刻ではありません）`}
          </dd>
        </div>
      </dl>

      {props.user.storage === null ? null : (
        <AdminQuotaMeter
          label={props.user.displayName}
          used={props.user.storage.bytesUsed}
          reserved={props.user.storage.bytesReserved}
          limit={props.user.storage.bytesLimit}
        />
      )}

      <div className="admin-actions">
        <div className="admin-actions__group">
          <h3 className="admin-actions__title">権限</h3>
          <label className="field">
            <span className="field__label">権限</span>
            <select
              className="select"
              value={role}
              disabled={props.isSelf}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              {ROLES.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="button"
            disabled={props.busy || props.isSelf || role === props.user.role}
            onClick={() => props.onRequest({ kind: 'role', user: props.user, role })}
          >
            権限を変更
          </button>
        </div>

        <div className="admin-actions__group">
          <h3 className="admin-actions__title">アカウントの停止</h3>
          <p className="panel__hint">
            停止したアカウントはサインインできず、既存のセッションも次の要求で拒否されます。保存されたデータは削除されません。
          </p>
          {props.user.banned ? (
            <button
              type="button"
              className="button"
              disabled={props.busy}
              onClick={() => props.onRequest({ kind: 'unban', user: props.user })}
            >
              停止を解除
            </button>
          ) : (
            <button
              type="button"
              className="button"
              disabled={props.busy || props.isSelf}
              onClick={() => props.onRequest({ kind: 'ban', user: props.user, reason: '' })}
            >
              アカウントを停止
            </button>
          )}
        </div>

        {props.canManageQuota ? (
          <div className="admin-actions__group">
            <h3 className="admin-actions__title">保存容量の上限</h3>
            <div className="admin-actions__row">
              <label className="field">
                <span className="field__label">上限</span>
                <input
                  className="input input--numeric"
                  type="number"
                  min={0}
                  step="0.5"
                  value={quotaAmount}
                  onChange={(event) => setQuotaAmount(event.target.value)}
                />
              </label>
              <label className="field">
                <span className="field__label">単位</span>
                <select
                  className="select"
                  value={quotaUnit}
                  onChange={(event) => setQuotaUnit(event.target.value as QuotaUnit)}
                >
                  <option value="MiB">MiB</option>
                  <option value="GiB">GiB</option>
                </select>
              </label>
              <button type="button" className="button" disabled={working} onClick={() => void applyQuota()}>
                上限を変更
              </button>
            </div>
            <p className="panel__hint">
              現在の使用量を下回る上限はサーバーが拒否します。上限を上げるとその分だけ費用の上限も上がります。
            </p>
          </div>
        ) : null}

        {props.canInvite ? (
          <div className="admin-actions__group">
            <h3 className="admin-actions__title">アカウントの復旧</h3>
            <p className="panel__hint">
              端末を失った利用者に、新しいパスキーを登録するためのURLを発行します。URLは発行時に一度だけ表示されます。本人確認は画面外で行ってください。
            </p>
            <button type="button" className="button" disabled={working} onClick={() => void issueRecovery()}>
              再登録用URLを発行
            </button>
          </div>
        ) : null}

        <div className="admin-actions__group">
          <h3 className="admin-actions__title">パスキー</h3>
          {passkeys === null ? (
            <button type="button" className="button button--flat" onClick={() => void loadPasskeys()}>
              パスキーを読み込む
            </button>
          ) : (
            <>
              <p className="panel__hint">{formatCount(passkeys.length)} 件</p>
              <ul className="admin-passkeys">
                {passkeys.map((key) => (
                  <li key={key.id} className="admin-passkeys__item">
                    <span>{key.backedUp ? '同期あり' : '同期なし'}</span>
                    <span className="panel__hint">登録 {formatMoment(key.createdAt)}</span>
                    <span className="panel__hint">最終使用 {formatMoment(key.lastUsedAt)}</span>
                    <button
                      type="button"
                      className="button button--flat"
                      disabled={props.busy || passkeys.length <= 1}
                      title={
                        passkeys.length <= 1
                          ? '最後のパスキーは削除できません。先に再登録用URLを発行してください。'
                          : undefined
                      }
                      onClick={() => props.onRequest({ kind: 'passkey', user: props.user, passkey: key })}
                    >
                      削除
                    </button>
                  </li>
                ))}
                {passkeys.length === 0 ? <li>登録されているパスキーはありません。</li> : null}
              </ul>
            </>
          )}
          {passkeyError === null ? null : (
            <p className="notice notice--error" role="alert">
              <span className="notice__body">{passkeyError}</span>
            </p>
          )}
        </div>

        <div className="admin-actions__group admin-actions__group--danger">
          <h3 className="admin-actions__title">アカウントの削除</h3>
          <p className="panel__hint">
            保存されたオブジェクトを削除してから利用者の行を削除します。実験・リビジョン・パスキーも連鎖して削除されます。元に戻せません。
          </p>
          <button
            type="button"
            className="button"
            disabled={props.busy || props.isSelf}
            onClick={() => props.onRequest({ kind: 'delete', user: props.user })}
          >
            アカウントを完全に削除
          </button>
        </div>
      </div>
    </section>
  )
}
