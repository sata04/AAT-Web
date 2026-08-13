/**
 * Turning a WebAuthn failure into something a researcher can act on.
 *
 * "パスキーの処理に失敗しました" is not a message; it is a shrug. The ceremony
 * fails for genuinely different reasons — the user pressed Escape, the device
 * has no credential for this deployment, the relying-party id is misconfigured,
 * the authenticator cannot do discoverable credentials — and each of those has a
 * different next step. Collapsing them loses the only information the user has.
 *
 * Where the reasons come from: Better Auth's passkey client runs the ceremony
 * through `@simplewebauthn/browser`, catches whatever is thrown, and returns
 * `{ data: null, error: { code, message, status, statusText } }`. `code` is a
 * `WebAuthnErrorCode` when the failure was local to the browser, one of Better
 * Auth's own codes when the failure was in its verification step, or an AAT
 * taxonomy code when the Worker refused. It also *replaces* the message and
 * drops the `cause`, so the original `DOMException` is not reachable — the code
 * is all there is, and this module is where it is read.
 *
 * ## The one distinction the platform refuses to make
 *
 * `NotAllowedError` arrives as `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`, and the
 * specification deliberately overloads it: a user who cancelled, a user with no
 * credential for this relying party, and a ceremony that timed out are all the
 * same error, because distinguishing them would turn the authenticator into an
 * account-existence oracle. That is a privacy property, not a bug, so this
 * module does not guess. It names both plausible causes and gives the action for
 * each, which is the honest and still-actionable answer.
 *
 * What *can* be distinguished is checked before the ceremony starts:
 * `supportsWebAuthn()` separates "this browser cannot do passkeys at all" and
 * "this page is not in a secure context" from anything the user did.
 */

/** The shape Better Auth's passkey client returns in its `error` slot. */
export interface PasskeyClientError {
  code?: string | undefined
  message?: string | undefined
  status?: number | undefined
}

export interface PasskeyFailure {
  /** One short line, suitable as the notice's first sentence. */
  summary: string
  /** What to do about it. Empty only when there is genuinely nothing to suggest. */
  action: string
}

/**
 * Whether a passkey ceremony can be attempted at all.
 *
 * `isSecureContext` is checked separately from `PublicKeyCredential` because the
 * two failures have different fixes and one of them is an operator's problem,
 * not the user's.
 */
export function supportsWebAuthn(): PasskeyFailure | null {
  if (typeof window === 'undefined') return null
  if (!window.isSecureContext) {
    return {
      summary: 'このページは安全な接続（HTTPS）ではないため、パスキーを利用できません。',
      action: 'https:// で始まるアドレスから開き直してください。解決しない場合は管理者にご連絡ください。',
    }
  }
  if (typeof window.PublicKeyCredential !== 'function') {
    return {
      summary: 'このブラウザはパスキー（WebAuthn）に対応していません。',
      action:
        '最新の Safari、Chrome、Edge、Firefox のいずれかでお試しください。解析機能はサインインなしでそのまま利用できます。',
    }
  }
  return null
}

const CANCELLED_OR_MISSING: PasskeyFailure = {
  summary: 'パスキーの確認がキャンセルされたか、この端末に使用できるパスキーが見つかりませんでした。',
  action:
    'もう一度お試しください。この端末にまだパスキーを登録していない場合は、登録済みの端末で操作するか、管理者に再登録用の招待を依頼してください。',
}

/**
 * Describe a failed sign-in or registration ceremony.
 *
 * `intent` only changes the wording of the shared cases; the codes are the same
 * on both paths because the same client runs both ceremonies.
 */
export function describePasskeyFailure(
  error: PasskeyClientError | null | undefined,
  intent: 'authenticate' | 'register',
): PasskeyFailure {
  const code = error?.code ?? ''

  switch (code) {
    // NotAllowedError. Cancellation, no matching credential and timeout are one
    // error by design — see the module comment.
    case 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY':
    case 'ERROR_CEREMONY_ABORTED':
    case 'AUTH_CANCELLED':
    case 'REGISTRATION_CANCELLED':
      return intent === 'register'
        ? {
            summary: 'パスキーの作成がキャンセルされました。',
            action: '「パスキーを作成」をもう一度押して、画面の指示に従ってください。',
          }
        : CANCELLED_OR_MISSING

    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
      return {
        summary: 'この認証器にはすでにパスキーが登録されています。',
        action: '別の端末やセキュリティキーを使うか、そのままサインインしてください。',
      }

    case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      return {
        summary: 'この認証器は、AATが必要とする「見つけられるパスキー」に対応していません。',
        action: '端末内蔵の生体認証、または対応するセキュリティキーをご利用ください。',
      }

    case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
    case 'ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE':
      return {
        summary: 'この認証器は本人確認（生体認証やPIN）に対応していません。',
        action: '端末のロック解除方法を設定してから、もう一度お試しください。',
      }

    case 'ERROR_INVALID_DOMAIN':
    case 'ERROR_INVALID_RP_ID':
      return {
        summary:
          'このサイトの設定（WebAuthn の relying party ID）が正しくないため、認証手続きを開始できません。',
        action: '利用者側では解決できません。管理者にこのメッセージをお伝えください。',
      }

    case 'ERROR_AUTHENTICATOR_GENERAL_ERROR':
    case 'ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG':
    case 'ERROR_MALFORMED_PUBKEYCREDPARAMS':
    case 'ERROR_INVALID_USER_ID_LENGTH':
      return {
        summary: '認証器がこの要求を処理できませんでした。',
        action: '別の端末やセキュリティキーでお試しください。繰り返す場合は管理者にご連絡ください。',
      }

    // Better Auth's own verification failures and AAT's taxonomy codes. The
    // server already phrased these in Japanese, so its message is used verbatim.
    default:
      break
  }

  const message = error?.message ?? ''
  if (message.length > 0) {
    return {
      summary: message,
      action: 'しばらくしてからもう一度お試しください。繰り返す場合は管理者にご連絡ください。',
    }
  }

  return {
    summary:
      intent === 'register' ? 'パスキーを登録できませんでした。' : 'パスキーでサインインできませんでした。',
    action: 'しばらくしてからもう一度お試しください。繰り返す場合は管理者にご連絡ください。',
  }
}
