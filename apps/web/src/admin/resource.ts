/**
 * One shape for "a thing this screen asked the cloud for".
 *
 * Seven screens read between one and five endpoints each, and every one of those reads has the same
 * four outcomes: still loading, loaded, refused with a taxonomy code, or the cloud is not there at
 * all. Writing that out per call site produced — in the first draft of this console — four subtly
 * different spellings of "loading", two of which rendered nothing at all while the request was in
 * flight. A screen that renders nothing during a load is indistinguishable from a screen reporting
 * that there is nothing, which for a user list or an audit log is a materially different and much
 * more reassuring claim than the truth.
 *
 * So the state is named once, here, and every panel in the console renders it through the same
 * component. The type is deliberately *not* `CloudOutcome<T> | null`: `null` for "not asked yet" is
 * how a screen ends up unable to distinguish "loading" from "loaded nothing", which is the bug this
 * exists to prevent.
 *
 * ## Why `unavailable` stays separate from `error`
 *
 * `src/cloud/gateway.ts` reads a 404 as "this deployment has no cloud half", unconditionally, and
 * that reading is load-bearing for the local-first promise. In an admin console it has a second
 * consequence worth keeping visible: a resource that genuinely does not exist *also* answers 404,
 * so an admin screen must phrase this state as "not available or not found" rather than as an
 * outage. Collapsing the two into one error state would make the console claim a deployment-wide
 * failure every time somebody follows a stale id.
 */

import type { ErrorCode } from '@aat/shared'
import type { CloudOutcome } from '../cloud/gateway.ts'

export type AdminResource<T> =
  /** The request is in flight, or has not been made yet. Rendered as words, never as blankness. */
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  /** The cloud is not reachable, not configured, or the resource is not there. */
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; code: ErrorCode; message: string; retryable: boolean }

export const LOADING: AdminResource<never> = { kind: 'loading' }

/** Fold a gateway outcome into the console's state. Total, so no caller can forget a case. */
export function resourceOf<T>(outcome: CloudOutcome<T>): AdminResource<T> {
  if (outcome.ok) return { kind: 'ready', value: outcome.value }
  if (outcome.kind === 'unavailable') return { kind: 'unavailable', message: outcome.message }
  return {
    kind: 'error',
    code: outcome.code,
    message: outcome.message,
    retryable: outcome.retryable,
  }
}

/**
 * The sentence a failed panel shows, and what to offer next to it.
 *
 * `FORBIDDEN` is called out by name because it is the one failure whose cause the reader can
 * neither retry away nor wait out — the Worker has refused this account the capability, and the
 * client-side navigation gate deliberately does not enforce anything, so reaching a panel and being
 * refused by the server is an expected path rather than a bug. Saying "権限がありません" there,
 * instead of the generic message, is the difference between an operator asking for a role change
 * and an operator reloading forever.
 */
export interface AdminFailureAdvice {
  summary: string
  /** Whether a retry button is worth offering. A refusal is not retried; an outage is. */
  retryable: boolean
}

export function describeFailure(resource: AdminResource<unknown>): AdminFailureAdvice | null {
  if (resource.kind === 'unavailable') {
    return { summary: `${resource.message}（この項目は表示できません）`, retryable: true }
  }
  if (resource.kind !== 'error') return null
  if (resource.code === 'FORBIDDEN') {
    return {
      summary: `この情報を読む権限がありません。サーバーが拒否しました（${resource.message}）。`,
      retryable: false,
    }
  }
  if (resource.code === 'AUTH_REQUIRED') {
    return { summary: 'セッションが失効しました。サインインし直してください。', retryable: false }
  }
  if (resource.code === 'RATE_LIMITED') {
    return {
      summary: `要求が多すぎます。しばらく待って再試行してください（${resource.message}）。`,
      retryable: true,
    }
  }
  return { summary: resource.message, retryable: resource.retryable }
}

/** The value if it is there, otherwise `fallback`. For panels that can show a partial screen. */
export function valueOr<T>(resource: AdminResource<T>, fallback: T): T {
  return resource.kind === 'ready' ? resource.value : fallback
}
