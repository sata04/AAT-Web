/**
 * Redeeming an invitation: `/register?token=…` and `/recover?token=…`.
 *
 * One component serves both because the flow is identical — exchange the token
 * for a registration context, run a WebAuthn registration ceremony against that
 * context, land in an authenticated session — and because the token handling is
 * the security-critical part of this application's client. Two copies of it
 * would be two things to audit and two places for them to drift.
 *
 * The order of the first three steps is deliberate and is the whole point:
 *
 *   1. read the token from the URL,
 *   2. remove it from the URL, synchronously, in the same statement,
 *   3. only then start anything that can await.
 *
 * `takeInvitationToken` does 1 and 2 and cannot be made to do them in the other
 * order; see `src/auth/invitation.ts` for the full list of places the raw token
 * is kept out of, and how each is guaranteed. The consequence visible here is
 * that the token is a `const` in an effect and never reaches component state:
 * what this component stores is the *registration context*, which is opaque,
 * single-use, server-issued, and separately expiring.
 *
 * Because the scrub happens whether or not the exchange succeeds, an invitation
 * that is expired, revoked or already used leaves a clean URL behind — so the
 * screenshot the user sends when asking "why did this not work" contains no
 * secret, and neither does a Back press.
 */

import { useEffect, useRef, useState } from 'react'
import { authClient } from '../auth/client.ts'
import { type RegistrationContext, redeemInvitation, takeInvitationToken } from '../auth/invitation.ts'
import { describePasskeyFailure, type PasskeyFailure, supportsWebAuthn } from '../auth/webauthn.ts'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { TABLE_SCROLL_PROPS } from '../components/table-scroll.ts'
import { Link, useNavigate } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

type Phase =
  /** Exchanging the token. The token no longer exists in the URL by this point. */
  | { kind: 'exchanging' }
  | { kind: 'ready'; context: RegistrationContext }
  | { kind: 'registering'; context: RegistrationContext }
  /** No `token` parameter — a bookmarked or re-opened link, most likely. */
  | { kind: 'no-token' }
  /** The server refused the invitation. Terminal: the token is gone and cannot be retried. */
  | { kind: 'refused'; message: string }
  | { kind: 'done' }

export interface InvitationScreenProps {
  /** `register` creates a new user; `recover` adds a passkey to an existing one. */
  mode: 'register' | 'recover'
}

const COPY = {
  register: {
    title: 'アカウントの作成',
    description: '招待リンクからパスキーを登録します。パスワードは設定しません。',
    action: 'パスキーを作成',
    missing:
      '招待リンクに含まれるトークンが見つかりません。招待メッセージのリンクをもう一度開いてください。リンクは一度しか使えないため、すでに使用済みの場合は管理者に再発行を依頼してください。',
    doneTitle: 'アカウントを作成しました',
  },
  recover: {
    title: 'パスキーの再登録',
    description: '再登録用リンクから、このアカウントに新しいパスキーを追加します。',
    action: 'パスキーを登録',
    missing:
      '再登録リンクに含まれるトークンが見つかりません。管理者から受け取ったリンクをもう一度開いてください。リンクは一度しか使えないため、すでに使用済みの場合は管理者に再発行を依頼してください。',
    doneTitle: 'パスキーを登録しました',
  },
} as const

export function InvitationScreen(props: InvitationScreenProps): React.JSX.Element {
  const copy = COPY[props.mode]
  const session = useSession()
  const navigate = useNavigate()
  const [phase, setPhase] = useState<Phase>({ kind: 'exchanging' })
  const [failure, setFailure] = useState<PasskeyFailure | null>(null)
  const started = useRef(false)

  useEffect(() => {
    // Latched: the token can only be taken once, so a second invocation — which
    // React's StrictMode guarantees in development — must not conclude that the
    // link was tokenless and overwrite a redemption already in flight.
    if (started.current) return
    started.current = true

    const token = takeInvitationToken()
    if (token === null) {
      setPhase({ kind: 'no-token' })
      return
    }

    void redeemInvitation(token).then((outcome) => {
      if (!outcome.ok) {
        setPhase({ kind: 'refused', message: outcome.message })
        return
      }
      setPhase({ kind: 'ready', context: outcome.value })
    })
  }, [])

  useEffect(() => {
    // The ceremony opened a session; go where the user was headed. Replaced
    // rather than pushed, because the invitation URL is spent and Back must not
    // return to it.
    if (phase.kind === 'done' && session.status === 'signed-in') navigate('/', { replace: true })
  }, [phase.kind, session.status, navigate])

  const register = async (context: RegistrationContext) => {
    setFailure(null)
    setPhase({ kind: 'registering', context })
    const result = await authClient.passkey.addPasskey({ context: context.registrationContext })
    if (result.error !== null) {
      // A cancelled or failed ceremony does not spend the context — the server
      // only consumes it on a verified registration — so the user can try again
      // rather than having to ask for a new invitation.
      setFailure(describePasskeyFailure(result.error, 'register'))
      setPhase({ kind: 'ready', context })
      return
    }
    await session.refresh()
    setPhase({ kind: 'done' })
  }

  const unsupported = supportsWebAuthn()

  return (
    <ScreenFrame title={copy.title} description={copy.description} centred>
      <section className="panel panel--framed" aria-label={copy.title}>
        {phase.kind === 'exchanging' ? (
          <p className="panel__hint" role="status" aria-live="polite">
            招待を確認しています…
          </p>
        ) : null}

        {phase.kind === 'no-token' ? (
          <div className="notice notice--warning" role="alert">
            <span className="notice__body">{copy.missing}</span>
          </div>
        ) : null}

        {phase.kind === 'refused' ? (
          <div className="notice notice--error" role="alert">
            <span className="notice__body">
              {phase.message}
              {'\n'}
              招待リンクは一度しか使えません。管理者に再発行を依頼してください。
            </span>
          </div>
        ) : null}

        {phase.kind === 'ready' || phase.kind === 'registering' ? (
          <>
            {/* Shown only when the server chose to say who this invitation is
                for. It is a courtesy — the flow completes without it — but it is
                the user's one chance to notice they were sent the wrong link. */}
            {phase.context.displayName === undefined && phase.context.role === undefined ? null : (
              <div {...TABLE_SCROLL_PROPS}>
                <table className="data-table">
                  <tbody>
                    {phase.context.displayName === undefined ? null : (
                      <tr>
                        <th scope="row">表示名</th>
                        <td>{phase.context.displayName}</td>
                      </tr>
                    )}
                    {phase.context.role === undefined ? null : (
                      <tr>
                        <th scope="row">権限</th>
                        <td>{phase.context.role}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {unsupported === null ? (
              <>
                <p className="panel__hint">
                  端末の生体認証、画面ロック、またはセキュリティキーで本人確認を行います。
                </p>
                <div className="screen__actions">
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={phase.kind === 'registering'}
                    onClick={() => void register(phase.context)}
                  >
                    {phase.kind === 'registering' ? '登録中…' : copy.action}
                  </button>
                </div>
                <p className="panel__hint" role="status" aria-live="polite">
                  {phase.kind === 'registering' ? '端末の画面に表示される指示に従ってください。' : ''}
                </p>
              </>
            ) : (
              <div className="notice notice--error" role="alert">
                <span className="notice__body">
                  {unsupported.summary}
                  {'\n'}
                  {unsupported.action}
                </span>
              </div>
            )}

            {failure === null ? null : (
              <div className="notice notice--error" role="alert">
                <span className="notice__body">
                  {failure.summary}
                  {'\n'}
                  {failure.action}
                </span>
              </div>
            )}
          </>
        ) : null}

        {phase.kind === 'done' ? (
          <>
            <div className="notice notice--info" role="status">
              <span className="notice__body">{copy.doneTitle}</span>
            </div>
            {/* Reached only if the session did not open — the redirect above
                handles the normal case. Saying so beats a silent dead end. */}
            {session.status === 'signed-in' ? null : (
              <p className="panel__hint">
                登録は完了しました。<Link to="/sign-in">サインイン</Link>
                から、作成したパスキーでサインインしてください。
              </p>
            )}
          </>
        ) : null}

        {phase.kind === 'no-token' || phase.kind === 'refused' ? (
          <p className="panel__hint">
            サインインしなくても、<Link to="/">解析画面</Link>
            でCSVの読み込み・解析・書き出しはすべて利用できます。
          </p>
        ) : null}
      </section>
    </ScreenFrame>
  )
}
