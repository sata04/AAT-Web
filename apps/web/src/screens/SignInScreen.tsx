/**
 * Sign in. Passkeys, and nothing else.
 *
 * There is no email field and no password field on this screen, and there never
 * will be. AAT collects no address (`worker/auth/identity.ts` explains the
 * synthetic `@aat.invalid` value that exists only because the auth framework's
 * schema demands one) and stores no password, so a field for either would be a
 * box that collects data the system has no use for and cannot verify. One
 * button, one ceremony.
 *
 * ## Why conditional UI (autofill) is not used here
 *
 * `signIn.passkey({ autoFill: true })` attaches the ceremony to a form field
 * annotated `autocomplete="username webauthn"`, so the browser can offer the
 * passkey inline while the user types their username. This screen has no
 * username to type — that is the entire design — so conditional mediation has
 * nothing to attach to. Adding an inert text input purely to host it would put a
 * field on the screen that collects nothing, announces itself to assistive
 * technology as an editable textbox, and invites a password manager to fill it.
 * The modal ceremony the button starts shows the same account picker, so the
 * user loses nothing.
 *
 * What *is* checked before the button does anything: whether this browser can do
 * WebAuthn at all, and whether the page is in a secure context. Those are the
 * two failures that are genuinely distinguishable in advance, and both have a
 * different answer from "try again".
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { authClient } from '../auth/client.ts'
import { describePasskeyFailure, type PasskeyFailure, supportsWebAuthn } from '../auth/webauthn.ts'
import { ScreenFrame } from '../components/ScreenFrame.tsx'
import { Link, useNavigate } from '../router/Router.tsx'
import { useSession } from '../session/SessionProvider.tsx'

export function SignInScreen(): React.JSX.Element {
  const session = useSession()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<PasskeyFailure | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)

  // Evaluated once: neither answer can change while the screen is open.
  const unsupported = useMemo(supportsWebAuthn, [])

  useEffect(() => {
    // Arriving here with a session already open is not an error; it just means
    // the screen has nothing to do. Replace rather than push, so Back does not
    // bounce between the analyzer and a screen that immediately redirects.
    if (session.status === 'signed-in') navigate('/', { replace: true })
  }, [session.status, navigate])

  useEffect(() => {
    // The single action on a single-purpose screen; focusing it saves a Tab and
    // puts the screen reader on the thing the user came for.
    if (unsupported === null) primaryRef.current?.focus()
  }, [unsupported])

  const signIn = async () => {
    setFailure(null)
    setPending(true)
    try {
      const result = await authClient.signIn.passkey()
      if (result.error !== null) {
        setFailure(describePasskeyFailure(result.error, 'authenticate'))
        return
      }
      // The cookie is set; the provider is the one place that knows who that is.
      await session.refresh()
      navigate('/', { replace: true })
    } finally {
      setPending(false)
    }
  }

  return (
    <ScreenFrame
      title="サインイン"
      description="AAT はパスキーでサインインします。パスワードもメールアドレスも使用しません。"
      centred
    >
      <section className="panel panel--framed" aria-label="パスキーでサインイン">
        {unsupported === null ? (
          <>
            <p className="panel__hint">
              端末の生体認証、画面ロック、またはセキュリティキーで本人確認を行います。
            </p>

            <div className="screen__actions">
              <button
                type="button"
                className="button button--primary"
                ref={primaryRef}
                disabled={pending}
                onClick={() => void signIn()}
              >
                {pending ? '確認中…' : 'パスキーでサインイン'}
              </button>
            </div>

            {/* Polite, because the ceremony already has the user's attention. */}
            <p className="panel__hint" role="status" aria-live="polite">
              {pending ? '端末の画面に表示される指示に従ってください。' : ''}
            </p>

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
        ) : (
          <div className="notice notice--error" role="alert">
            <span className="notice__body">
              {unsupported.summary}
              {'\n'}
              {unsupported.action}
            </span>
          </div>
        )}

        <hr className="separator" />

        <p className="panel__hint">
          アカウントは招待によってのみ作成されます。招待リンクをお持ちでない場合は管理者にご依頼ください。
          サインインしなくても、
          <Link to="/">解析画面</Link>
          でCSVの読み込み・解析・書き出しはすべて利用できます。
        </p>
      </section>
    </ScreenFrame>
  )
}
