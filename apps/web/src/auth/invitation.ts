/**
 * Reading — and immediately destroying — an invitation token.
 *
 * An invitation token is a bearer secret that creates an account. It arrives in
 * a URL because that is the only channel this system has (there is no email
 * address to send anything to; see `worker/auth/identity.ts`), and a URL is the
 * least private place a secret can be: it is in the address bar, in the history
 * database, in `document.referrer` of anything the page loads, in a screen
 * share, and in whatever the user pastes into a chat window when asking for
 * help. So it is taken out of the URL at the first possible instant and never
 * put anywhere it could persist.
 *
 * The rules this module exists to enforce, and how each is guaranteed:
 *
 *  - **Never logged.** Nothing here calls `console`, and the token is not
 *    interpolated into any string that a logger could later receive. The one
 *    place it becomes part of a string is `JSON.stringify` for the request body.
 *  - **Never in an error message.** `authRequest` builds failure messages from
 *    the HTTP status and the parsed response body only, and it never throws — so
 *    there is no exception whose stack or message could carry the request body.
 *  - **Never stored.** No `localStorage`, no `sessionStorage`, no IndexedDB, no
 *    cookie. The token exists as a function argument and as a `fetch` body, and
 *    then it is garbage.
 *  - **Never held in React state.** `takeInvitationToken` returns it to the
 *    caller's local scope inside an effect; the screens pass it straight to
 *    `redeemInvitation` and keep only the *registration context* the server
 *    hands back, which is a separate, single-use, server-issued value.
 *  - **Removed from the URL before the first await.** `takeInvitationToken`
 *    rewrites the address bar synchronously, between reading the parameter and
 *    returning it. There is no suspension point in between, so an interrupted
 *    or abandoned redemption cannot leave the token in the URL.
 */

import { authRequest, type CloudOutcome } from '../cloud/gateway.ts'
import { replaceLocation } from '../router/Router.tsx'

/** The query parameter an invitation link uses. */
const TOKEN_PARAMETER = 'token'

/**
 * Take the invitation token out of the current URL.
 *
 * "Take" rather than "read": the parameter is removed from the address bar
 * before this function returns, using `history.replaceState` so the token is not
 * one Back press away either. Any other query parameters are preserved — the
 * token is deleted individually rather than the whole query being dropped.
 *
 * Calling it a second time returns `null`, which is what makes it safe under
 * React's StrictMode double-effect: the second invocation finds nothing,
 * and callers must therefore latch the first result rather than re-reading.
 */
export function takeInvitationToken(): string | null {
  const search = new URLSearchParams(window.location.search)
  const token = search.get(TOKEN_PARAMETER)
  if (token === null || token.length === 0) return null

  search.delete(TOKEN_PARAMETER)
  const remaining = search.toString()
  replaceLocation(`${window.location.pathname}${remaining.length === 0 ? '' : `?${remaining}`}`)

  return token
}

/**
 * What the Worker hands back in exchange for a token.
 *
 * `registrationContext` is opaque, single-use and server-issued: it authorises
 * exactly one WebAuthn registration ceremony and expires on its own. It is not
 * the token and does not create an account by itself, which is why it — unlike
 * the token — is allowed to live in component state for the length of the
 * ceremony.
 *
 * `displayName`, `role` and `kind` are optional because they are a courtesy:
 * they let the screen show the invitee what they are about to become. A
 * deployment that does not return them still completes the flow.
 */
export interface RegistrationContext {
  registrationContext: string
  expiresAt?: string
  kind?: 'registration' | 'recovery'
  displayName?: string
  role?: string
}

/**
 * Exchange an invitation token for a registration context.
 *
 * The token is a parameter and appears exactly once, in the request body. It is
 * never returned, never stored and never named in the outcome — a failure comes
 * back as a taxonomy code (`INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_USED`,
 * `RECOVERY_INVALID`, `RATE_LIMITED`) with the server's Japanese message.
 */
export function redeemInvitation(token: string): Promise<CloudOutcome<RegistrationContext>> {
  return authRequest<RegistrationContext>('/aat/invitation/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}
