/**
 * Passkey management for the signed-in user.
 *
 * Two sources are merged here rather than one, because neither is complete on
 * its own. `/api/v1/me/passkeys` knows `lastUsedAt` — AAT records it on every
 * successful assertion — and Better Auth's `listUserPasskeys` knows the
 * `aaguid`, which is what turns "パスキー" into "iCloud Keychain". The merge is
 * by row id; both routes read the same table. If the plugin's listing is
 * unavailable the screen still works, just without provider names, which is why
 * the AAT route is the primary and the plugin's is the enrichment.
 *
 * ## The last passkey
 *
 * With no password, no email and no social login, the passkey *is* the account.
 * Deleting the last one is not a reversible mistake; it destroys access with no
 * self-service way back, and the only remedy is an administrator issuing a
 * recovery invitation to an account that can no longer prove it is theirs. So
 * the control is disabled with the reason stated — and that is not the
 * enforcement. `worker/routes/me.ts` counts the rows and refuses with
 * `FORBIDDEN`, because a disabled button is a hint, not a rule.
 *
 * ## Authenticator names
 *
 * `getAuthenticatorName` maps an AAGUID to a provider name from the plugin's
 * best-effort table. It returns `undefined` far more often than not: an AAGUID
 * names an authenticator *model*, and privacy-preserving platforms — Apple's,
 * under the default `attestation: "none"` this deployment uses — report an
 * all-zero value that matches nothing. That is the expected case, not a
 * failure, so the fallback chain is user-set name, then provider name, then a
 * plain label plus the device type, and the row is never blank.
 */

import { getAuthenticatorName } from '@better-auth/passkey'
import { useCallback, useEffect, useState } from 'react'
import { authClient } from '../auth/client.ts'
import { describePasskeyFailure, supportsWebAuthn } from '../auth/webauthn.ts'
import { deleteMyPasskey, fetchMyPasskeys, type MyPasskey } from '../cloud/gateway.ts'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { Link } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

interface PasskeyRow extends MyPasskey {
  /** From the plugin's listing; absent when it is unavailable or reports all zeroes. */
  authenticator: string | undefined
}

/** Dates are shown to the minute: a passkey's history is not a stopwatch. */
function formatMoment(iso: string | null): string {
  if (iso === null) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function labelFor(row: PasskeyRow): string {
  if (row.name !== null && row.name.length > 0) return row.name
  if (row.authenticator !== undefined) return row.authenticator
  return row.deviceType === 'multiDevice' ? '同期パスキー' : 'この端末のパスキー'
}

export function SecurityScreen(): React.JSX.Element {
  const session = useSession()
  const [rows, setRows] = useState<PasskeyRow[] | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)

  const reload = useCallback(async () => {
    const mine = await fetchMyPasskeys()
    if (!mine.ok) {
      setRows([])
      setNotice({ tone: 'error', text: mine.message })
      return
    }
    // Enrichment, so it is allowed to fail: losing it costs a provider name,
    // not the screen. The AAT route above is the one that must succeed.
    const plugin = await authClient.passkey.listUserPasskeys().catch(() => ({ data: null }))
    const aaguids = new Map<string, string | undefined>(
      (plugin.data ?? []).map((entry) => [entry.id, entry.aaguid]),
    )
    setRows(
      mine.value.passkeys.map((row) => ({
        ...row,
        authenticator: getAuthenticatorName(aaguids.get(row.id)),
      })),
    )
  }, [])

  useEffect(() => {
    if (session.status !== 'signed-in') return
    void reload()
  }, [session.status, reload])

  const addPasskey = async () => {
    const unsupported = supportsWebAuthn()
    if (unsupported !== null) {
      setNotice({ tone: 'error', text: `${unsupported.summary}\n${unsupported.action}` })
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const result = await authClient.passkey.addPasskey()
      if (result.error !== null) {
        const failure = describePasskeyFailure(result.error, 'register')
        setNotice({ tone: 'error', text: `${failure.summary}\n${failure.action}` })
        return
      }
      setNotice({ tone: 'info', text: 'パスキーを追加しました。' })
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const rename = async (id: string, name: string) => {
    setBusy(true)
    try {
      const result = await authClient.passkey.updatePasskey({ id, name })
      if (result.error !== null) {
        setNotice({ tone: 'error', text: result.error.message ?? '名前を変更できませんでした。' })
        return
      }
      setRenaming(null)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Deletion goes through AAT's own route, not the plugin's.
   *
   * `/api/v1/me/passkeys/:id` is the one that counts the user's remaining
   * credentials and refuses to remove the last, and that guard is the reason
   * this screen can offer deletion at all.
   */
  const remove = async (id: string) => {
    setBusy(true)
    try {
      const outcome = await deleteMyPasskey(id)
      if (!outcome.ok) {
        // The server's own FORBIDDEN message is the generic one. This is the
        // only way that route refuses a caller who owns the credential, so it
        // is worth translating into the specific reason.
        const text =
          outcome.kind === 'error' && outcome.code === 'FORBIDDEN'
            ? '最後のパスキーは削除できません。先に別の端末やセキュリティキーでパスキーを追加してください。'
            : outcome.message
        setNotice({ tone: 'error', text })
        return
      }
      setNotice({ tone: 'info', text: 'パスキーを削除しました。' })
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const revokeOtherSessions = async () => {
    setBusy(true)
    try {
      const result = await authClient
        .revokeOtherSessions()
        .catch(() => ({ error: { message: 'セッションを無効化できませんでした。' } }))
      setNotice(
        result.error === null || result.error === undefined
          ? { tone: 'info', text: 'この端末以外のセッションを無効化しました。' }
          : { tone: 'error', text: result.error.message ?? 'セッションを無効化できませんでした。' },
      )
    } finally {
      setBusy(false)
    }
  }

  if (session.status !== 'signed-in') {
    return (
      <ScreenFrame title="セキュリティ" centred>
        <section className="panel panel--framed" aria-label="サインインが必要です">
          <p className="panel__hint">
            {session.status === 'loading'
              ? 'セッションを確認しています…'
              : session.status === 'unavailable'
                ? 'このデプロイではクラウド機能を利用できません。パスキーの管理はサインインできる環境でのみ行えます。'
                : 'この画面を表示するにはサインインが必要です。'}
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

  const onlyOne = rows !== null && rows.length <= 1

  return (
    <ScreenFrame
      title="セキュリティ"
      description={`${session.user?.displayName ?? ''} のパスキーとセッションを管理します。`}
    >
      {notice === null ? null : (
        <div className={`notice notice--${notice.tone}`} role="status">
          <span className="notice__body">{notice.text}</span>
          <button type="button" className="button button--flat" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      <section className="panel panel--framed" aria-label="パスキー">
        <div className="panel__header">
          <h2 className="panel__title">パスキー</h2>
          <span className="panel__hint">{rows === null ? '読み込み中' : `${rows.length} 件`}</span>
        </div>

        {rows === null ? (
          <p className="panel__hint" role="status" aria-live="polite">
            読み込んでいます…
          </p>
        ) : (
          <div {...TABLE_SCROLL_PROPS}>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">名前</th>
                  <th scope="col">種類</th>
                  <th scope="col">登録日時</th>
                  <th scope="col">最終使用</th>
                  <th scope="col">
                    <span className="visually-hidden">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {renaming !== null && renaming.id === row.id ? (
                        <label className="field">
                          <span className="visually-hidden">パスキーの名前</span>
                          <input
                            className="input"
                            type="text"
                            value={renaming.name}
                            maxLength={64}
                            onChange={(event) => setRenaming({ id: row.id, name: event.target.value })}
                          />
                        </label>
                      ) : (
                        labelFor(row)
                      )}
                    </td>
                    <td>{row.backedUp ? '同期あり' : '同期なし'}</td>
                    <td>{formatMoment(row.createdAt)}</td>
                    <td>{formatMoment(row.lastUsedAt)}</td>
                    <td>
                      {renaming !== null && renaming.id === row.id ? (
                        <>
                          <button
                            type="button"
                            className="button button--flat"
                            disabled={busy || renaming.name.trim().length === 0}
                            onClick={() => void rename(row.id, renaming.name.trim())}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="button button--flat"
                            onClick={() => setRenaming(null)}
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="button button--flat"
                            disabled={busy}
                            onClick={() => setRenaming({ id: row.id, name: row.name ?? labelFor(row) })}
                          >
                            名前を変更
                          </button>
                          <button
                            type="button"
                            className="button button--flat"
                            disabled={busy || onlyOne}
                            title={
                              onlyOne
                                ? '最後のパスキーは削除できません。先に別のパスキーを追加してください。'
                                : undefined
                            }
                            onClick={() => void remove(row.id)}
                          >
                            削除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5}>登録されているパスキーはありません。</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        )}

        {onlyOne ? (
          <p className="panel__hint">
            パスキーが1つしかないため削除できません。端末を紛失したときに備えて、別の端末やセキュリティキーにもパスキーを追加しておくことをおすすめします。
          </p>
        ) : null}

        <div className="screen__actions">
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void addPasskey()}
          >
            パスキーを追加
          </button>
        </div>
      </section>

      <section className="panel panel--framed" aria-label="セッション">
        <div className="panel__header">
          <h2 className="panel__title">セッション</h2>
        </div>
        <p className="panel__hint">
          共有の端末でサインインしたままにしてしまった場合は、この端末以外のセッションをまとめて無効化できます。この端末のセッションは維持されます。
        </p>
        <div className="screen__actions">
          <button type="button" className="button" disabled={busy} onClick={() => void revokeOtherSessions()}>
            他の端末のセッションを無効化
          </button>
          <button type="button" className="button button--flat" onClick={() => void session.signOut()}>
            サインアウト
          </button>
        </div>
      </section>
    </ScreenFrame>
  )
}
