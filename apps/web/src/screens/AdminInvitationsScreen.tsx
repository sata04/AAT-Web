/**
 * `/admin/invitations` — the only way into this deployment.
 *
 * Registration is by invitation only, so every account that will ever exist here starts on this
 * screen. Three properties follow from that, and each is a decision rather than a default:
 *
 *  - **The token is shown once and the screen says so before it is shown.** `POST
 *    /admin/invitations` returns the plaintext token exactly once; the database holds its SHA-256
 *    and the listing route deliberately returns neither the token nor the hash. `AdminOneTimeSecret`
 *    carries that moment, with the warning above the value rather than after it.
 *  - **The state in the table is derived, not the column.** `registration_invites.status` has no
 *    `expired` value — expiry is a timestamp passing — so a listing that printed the column verbatim
 *    would show a fortnight-old dead link as 未使用, which is an invitation an administrator would
 *    reasonably believe still works. `invitationState` folds the clock in.
 *  - **The intended display name is part of issuing, not of registering.** The invited person types
 *    no name: `createInvitation` carries the name the administrator meant, so the identity in this
 *    system is one that somebody with `invitation:manage` chose. That is the whole of AAT's identity
 *    model — there is no email to verify against.
 *
 * The default lifetime is 48 hours. A registration link is a credential that creates an account, and
 * a fortnight of one sitting in an inbox is a fortnight of exposure for a convenience nobody asked
 * for; 48 hours covers "I will send this after the meeting" and the list offers the rest.
 */

import { hasCapability, ROLES, type Role } from '@aat/shared'
import { useCallback, useState } from 'react'
import { formatCount, formatMoment, roleLabel } from '../admin/format.ts'
import {
  DEFAULT_INVITATION_TTL_HOURS,
  INVITATION_PAGE_SIZE,
  INVITATION_TTL_OPTIONS,
  invitationKindLabel,
  invitationUrl,
  presentInvitation,
} from '../admin/invitations.ts'
import { useAdminResource } from '../admin/useAdminResource.ts'
import {
  createInvitation,
  type InvitationSummary,
  listInvitations,
  revokeInvitation,
} from '../cloud/gateway.ts'
import { AdminCapabilityNotice, AdminFrame } from '../components/AdminFrame.tsx'
import { AdminOneTimeSecret } from '../components/AdminOneTimeSecret.tsx'
import { AdminResourceNotice } from '../components/AdminResourceNotice.tsx'
import { Dialog } from '../components/Dialog.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { useSession } from '../session/SessionProvider.tsx'

interface DraftInvitation {
  kind: 'registration' | 'recovery'
  displayName: string
  role: Role
  ttlHours: number
  note: string
  targetUserId: string
}

const EMPTY_DRAFT: DraftInvitation = {
  kind: 'registration',
  displayName: '',
  role: 'Researcher',
  ttlHours: DEFAULT_INVITATION_TTL_HOURS,
  note: '',
  targetUserId: '',
}

export function AdminInvitationsScreen(): React.JSX.Element {
  const session = useSession()
  const canManage = hasCapability(session.capabilities, 'invitation:manage')

  const [draft, setDraft] = useState<DraftInvitation>(EMPTY_DRAFT)
  const [issued, setIssued] = useState<{ url: string; displayName: string; kind: string } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<InvitationSummary | null>(null)

  const invitations = useAdminResource(
    useCallback(() => listInvitations({ limit: INVITATION_PAGE_SIZE }), []),
    'invitations',
    canManage,
  )

  const rows = invitations.resource.kind === 'ready' ? invitations.resource.value.invitations : []
  const nameMissing = draft.displayName.trim() === ''
  const recoveryTargetMissing = draft.kind === 'recovery' && draft.targetUserId.trim() === ''

  const issue = async () => {
    setBusy(true)
    const outcome = await createInvitation({
      kind: draft.kind,
      role: draft.role,
      displayName: draft.displayName.trim(),
      ttlHours: draft.ttlHours,
      ...(draft.note.trim() === '' ? {} : { note: draft.note.trim() }),
      ...(draft.kind === 'recovery' ? { targetUserId: draft.targetUserId.trim() } : {}),
    })
    setBusy(false)
    if (!outcome.ok) {
      setNotice({ tone: 'error', text: outcome.message })
      return
    }
    // The one render of the plaintext token. It is not stored in this component beyond the URL, it
    // is never put in the address bar, and dismissing the panel drops it.
    setIssued({
      url: invitationUrl(window.location.origin, draft.kind, outcome.value.invitation.token),
      displayName: draft.displayName.trim(),
      kind: draft.kind,
    })
    setDraft({ ...EMPTY_DRAFT, kind: draft.kind, role: draft.role, ttlHours: draft.ttlHours })
    setNotice(null)
    invitations.reload()
  }

  const revoke = async (invitation: InvitationSummary) => {
    setBusy(true)
    const outcome = await revokeInvitation(invitation.id)
    setBusy(false)
    setRevoking(null)
    if (!outcome.ok) {
      setNotice({ tone: 'error', text: outcome.message })
      return
    }
    setNotice({ tone: 'info', text: `${invitation.displayName} 宛の招待を失効させました。` })
    invitations.reload()
  }

  return (
    <AdminFrame
      title="招待"
      description="このデプロイに参加できるのは招待された人だけです。招待には登録後の表示名・権限・有効期限を含めます。登録用URLは発行時に一度だけ表示され、後から再表示することはできません。"
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
          title={issued.kind === 'recovery' ? '再登録用URLを発行しました' : '登録用URLを発行しました'}
          description={`${issued.displayName} 本人にだけ渡してください。このURLを開いた人が${
            issued.kind === 'recovery' ? '既存のアカウントに新しいパスキーを登録' : 'アカウントを作成'
          }できます。`}
          url={issued.url}
          onDismiss={() => setIssued(null)}
        />
      )}

      {!canManage ? (
        <section className="panel panel--framed" aria-label="権限がありません">
          <AdminCapabilityNotice capability="invitation:manage" />
        </section>
      ) : null}

      {canManage ? (
        <section className="panel panel--framed" aria-label="招待の発行">
          <div className="panel__header">
            <h2 className="panel__title">招待を発行</h2>
          </div>
          <form
            className="admin-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (nameMissing || recoveryTargetMissing) return
              void issue()
            }}
          >
            <fieldset className="admin-form__fieldset">
              <legend className="field__label">種類</legend>
              {(
                [
                  { value: 'registration', label: '新規登録', hint: '新しいアカウントを作成します。' },
                  {
                    value: 'recovery',
                    label: '再登録（アカウント復旧）',
                    hint: '既存のアカウントに新しいパスキーを登録します。対象の内部IDが必要です。',
                  },
                ] as const
              ).map((option) => (
                <label key={option.value} className="admin-form__choice">
                  <input
                    type="radio"
                    name="invitation-kind"
                    value={option.value}
                    checked={draft.kind === option.value}
                    onChange={() => setDraft({ ...draft, kind: option.value })}
                  />
                  <span>{option.label}</span>
                  <span className="panel__hint">{option.hint}</span>
                </label>
              ))}
            </fieldset>

            <div className="run-filter__fields">
              <label className="field">
                <span className="field__label">表示名（登録後の識別子になります）</span>
                <input
                  className="input"
                  type="text"
                  required
                  maxLength={120}
                  value={draft.displayName}
                  onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
                />
                <span className="panel__hint">
                  AATはメールアドレスを保持しません。この表示名が実験一覧・監査ログに出る唯一の人間可読な識別子です。
                </span>
              </label>

              <label className="field">
                <span className="field__label">権限</span>
                <select
                  className="select"
                  value={draft.role}
                  onChange={(event) => setDraft({ ...draft, role: event.target.value as Role })}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </select>
                <span className="panel__hint">
                  研究者は他メンバーの実験を閲覧・再利用できます。閲覧者は自分の実験だけを見られます。
                </span>
              </label>

              <label className="field">
                <span className="field__label">有効期限</span>
                <select
                  className="select"
                  value={String(draft.ttlHours)}
                  onChange={(event) => setDraft({ ...draft, ttlHours: Number(event.target.value) })}
                >
                  {INVITATION_TTL_OPTIONS.map((option) => (
                    <option key={option.hours} value={String(option.hours)}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {draft.kind === 'recovery' ? (
                <label className="field">
                  <span className="field__label">対象の内部ID</span>
                  <input
                    className="input"
                    type="text"
                    required
                    maxLength={64}
                    value={draft.targetUserId}
                    onChange={(event) => setDraft({ ...draft, targetUserId: event.target.value })}
                  />
                  <span className="panel__hint">
                    「利用者」画面の各アカウントに表示されている内部IDです。存在しないIDはサーバーが拒否します。
                  </span>
                </label>
              ) : null}

              <label className="field">
                <span className="field__label">メモ（任意・招待の一覧にだけ表示されます）</span>
                <input
                  className="input"
                  type="text"
                  maxLength={500}
                  value={draft.note}
                  onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                />
              </label>
            </div>

            <div className="screen__actions">
              <button
                type="submit"
                className="button button--primary"
                disabled={busy || nameMissing || recoveryTargetMissing}
              >
                {busy ? '発行しています…' : '招待を発行'}
              </button>
            </div>
            <p className="panel__hint">
              発行すると登録用URLが一度だけ表示されます。控える前に閉じると、この招待は使えません（新しく発行し直してください）。
            </p>
          </form>
        </section>
      ) : null}

      <section className="panel panel--framed" aria-label="招待の一覧">
        <div className="panel__header">
          <h2 className="panel__title">発行済みの招待</h2>
          <span className="panel__hint">
            {invitations.resource.kind === 'ready' ? `${formatCount(rows.length)} 件` : ''}
          </span>
        </div>
        <AdminResourceNotice
          resource={invitations.resource}
          label="招待の一覧"
          enabled={canManage}
          onRetry={invitations.reload}
        />
        <p className="panel__hint">
          この一覧にトークンもそのハッシュも含まれません。使い捨てトークンは発行時の応答にだけ存在します。
        </p>

        {invitations.resource.kind === 'ready' ? (
          <div {...TABLE_SCROLL_PROPS}>
            <table className="data-table">
              <caption className="visually-hidden">発行済みの招待、その状態と有効期限</caption>
              <thead>
                <tr>
                  <th scope="col">表示名</th>
                  <th scope="col">種類</th>
                  <th scope="col">権限</th>
                  <th scope="col">状態</th>
                  <th scope="col">発行</th>
                  <th scope="col">期限</th>
                  <th scope="col">メモ</th>
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((invitation) => {
                  const presentation = presentInvitation(invitation)
                  return (
                    <tr key={invitation.id}>
                      <th scope="row">{invitation.displayName}</th>
                      <td>{invitationKindLabel(invitation.kind)}</td>
                      <td>{roleLabel(invitation.role)}</td>
                      <td>
                        <span className={`admin-flag admin-flag--${stateTone(presentation.state)}`}>
                          {presentation.label}
                        </span>
                      </td>
                      <td>{formatMoment(invitation.createdAt)}</td>
                      <td>{formatMoment(invitation.expiresAt)}</td>
                      <td>{invitation.note ?? '—'}</td>
                      <td>
                        {presentation.revocable ? (
                          <button
                            type="button"
                            className="button button--flat"
                            disabled={busy}
                            onClick={() => setRevoking(invitation)}
                          >
                            失効させる
                            <span className="visually-hidden">: {invitation.displayName} 宛の招待</span>
                          </button>
                        ) : (
                          <span className="panel__hint">操作できません</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8}>発行済みの招待はありません。</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {revoking === null ? null : (
        <Dialog
          title="招待を失効させます"
          description={
            `${revoking.displayName} 宛の${invitationKindLabel(revoking.kind)}の招待を失効させます。\n` +
            'このURLでは登録できなくなります。すでに登録が完了しているアカウントには影響しません。\n' +
            '必要になったら新しい招待を発行してください（同じURLは復元できません）。'
          }
          onClose={() => setRevoking(null)}
          footer={
            <>
              <button
                type="button"
                className="button button--flat"
                disabled={busy}
                onClick={() => setRevoking(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => void revoke(revoking)}
              >
                {busy ? '実行しています…' : '失効させる'}
              </button>
            </>
          }
        >
          <p className="panel__hint">発行日時: {formatMoment(revoking.createdAt)}</p>
        </Dialog>
      )}
    </AdminFrame>
  )
}

/** Which tone the state word carries. The word is the signal; this only tints it. */
function stateTone(state: string): 'good' | 'bad' | 'muted' {
  if (state === 'pending' || state === 'claimed') return 'good'
  if (state === 'revoked' || state === 'expired') return 'bad'
  return 'muted'
}
