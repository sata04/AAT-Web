/**
 * Invitation state, and the one place a registration URL is built.
 *
 * ## The state is derived, not read
 *
 * `registration_invites.status` holds `pending`, `claimed`, `used` or `revoked`. Expiry is *not* one
 * of those values: it is `expires_at` passing, and no writer sets a status when a clock ticks. So a
 * listing that showed the column verbatim would present a two-week-old, long-dead invitation as
 * 未使用 — an invitation an administrator would reasonably believe still works. {@link invitationState}
 * therefore folds the timestamp in, and it does so in the same order the Worker's redemption path
 * does: revoked first, then used, then expired, then claimed, then pending. Revocation outranks
 * expiry because "we withdrew this" is the fact worth recording even after the clock would have
 * killed it anyway.
 *
 * `claimed` deserves its own state rather than being folded into 未使用. It means somebody has begun
 * the passkey ceremony with this token — `claimInvitation` moved it there and stored a context hash
 * — and it reverts to claimable if the ceremony is abandoned. An administrator watching a colleague
 * register wants to see that the link was picked up.
 *
 * ## The URL is assembled here and nowhere else
 *
 * The plaintext token exists for exactly one render, in the response to `POST /admin/invitations`.
 * It is never stored (only its SHA-256 is), never returned by the listing, and cannot be recovered.
 * Building the URL in one tested function keeps that single moment from acquiring variants: one
 * function, two routes, and the mapping from `kind` to path is a table rather than a ternary spread
 * across a screen.
 */

import type { InvitationSummary } from '../cloud/gateway.ts'

export type InvitationState = 'pending' | 'claimed' | 'used' | 'revoked' | 'expired'

export interface InvitationPresentation {
  state: InvitationState
  /** The word shown in the table. Status is never conveyed by colour alone. */
  label: string
  /** Whether `POST /invitations/:id/revoke` can still do anything. */
  revocable: boolean
}

const STATE_LABELS: Readonly<Record<InvitationState, string>> = {
  pending: '未使用',
  claimed: '受理中',
  used: '使用済み',
  revoked: '失効済み',
  expired: '期限切れ',
}

export function invitationState(invitation: InvitationSummary, now: Date = new Date()): InvitationState {
  if (invitation.revokedAt !== null || invitation.status === 'revoked') return 'revoked'
  if (invitation.usedAt !== null || invitation.status === 'used') return 'used'
  const expiresAt = new Date(invitation.expiresAt).getTime()
  // An unparseable timestamp is treated as expired rather than as live. The failure mode of the
  // other choice is presenting a link as usable when nothing here knows whether it is.
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return 'expired'
  return invitation.status === 'claimed' ? 'claimed' : 'pending'
}

export function presentInvitation(
  invitation: InvitationSummary,
  now: Date = new Date(),
): InvitationPresentation {
  const state = invitationState(invitation, now)
  return {
    state,
    label: STATE_LABELS[state],
    // Only a live invitation can be withdrawn. `revokeInvitation` refuses everything else with
    // INVITE_INVALID, and offering a control that always fails is worse than not offering it.
    revocable: state === 'pending' || state === 'claimed',
  }
}

export function invitationKindLabel(kind: string): string {
  return kind === 'recovery' ? '再登録（アカウント復旧）' : '新規登録'
}

/**
 * The URL to hand to the invited person.
 *
 * `origin` is passed in rather than read from `window` so that this is testable and so that the
 * caller — which is a screen that already knows it is running in a browser — owns the one impure
 * step. The token goes in a query parameter because that is what `src/auth/invitation.ts` reads and
 * immediately scrubs from the address bar on arrival.
 */
export function invitationUrl(origin: string, kind: string, token: string): string {
  const path = kind === 'recovery' ? '/recover' : '/register'
  return `${origin.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`
}

/**
 * The lifetimes offered when issuing one.
 *
 * The route accepts 1 hour to 14 days. Short is the right default for a credential that grants
 * account creation: 48 hours covers "I will send this after the meeting" without leaving a live
 * registration link in an inbox for a fortnight. The list is deliberately short — every extra option
 * is a decision an administrator has to make on a screen where the interesting decision is the role.
 */
export const INVITATION_TTL_OPTIONS: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 1, label: '1時間' },
  { hours: 24, label: '24時間' },
  { hours: 48, label: '48時間' },
  { hours: 24 * 7, label: '7日' },
  { hours: 24 * 14, label: '14日（上限）' },
]

export const DEFAULT_INVITATION_TTL_HOURS = 48

/** Rows per page. The route's ceiling is 200; fifty is a screenful. */
export const INVITATION_PAGE_SIZE = 50

/**
 * Count the live invitations.
 *
 * Surfaced on the overview because an unused registration link is a standing way into the
 * deployment. Two of them outstanding for a group that has finished onboarding is worth noticing,
 * and it is the sort of thing nobody notices unless a number says it.
 */
export function countLiveInvitations(
  invitations: readonly InvitationSummary[],
  now: Date = new Date(),
): number {
  return invitations.reduce((total, invitation) => {
    const state = invitationState(invitation, now)
    return total + (state === 'pending' || state === 'claimed' ? 1 : 0)
  }, 0)
}
