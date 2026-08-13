/**
 * Presentation helpers for the admin console.
 *
 * Pure functions with no React and no fetch, for the usual reason this repository splits them out:
 * the interesting decisions — what counts as quota pressure, what a role is called in Japanese, how
 * a percentage of a byte limit is phrased — are worth testing without a DOM, and a component that
 * computes them inline cannot be.
 *
 * ## Numbers here are operational, not scientific
 *
 * `src/app/format.ts` exists for measurements and is deliberately strict: an absent statistic prints
 * an em dash rather than a zero, because printing `0.0000` for a number nobody computed is a claim.
 * The numbers on these screens are of a different kind — how many users exist, how many bytes are
 * stored — and for those a zero *is* the answer. So this module counts and formats plainly, and
 * reuses `formatBytes` from that module rather than growing a second byte formatter that would
 * eventually disagree with the one the analyzer shows.
 */

import { formatBytes } from '../app/format.ts'

export { formatBytes }

/** An integer with Japanese digit grouping. Counts are counts; a count is never fractional. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Math.trunc(value).toLocaleString('ja-JP')
}

/**
 * A timestamp to the minute, in the reader's locale.
 *
 * Deliberately the same shape as `src/runs/gallery.ts`'s: an administrator moving between the run
 * gallery and the audit log should not have to re-read two date formats. Null is `—` rather than
 * an empty cell, so "there is no such time" and "this column failed to render" look different.
 */
export function formatMoment(iso: string | null): string {
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

/** A timestamp to the second. Only the audit log needs this: two entries can share a minute. */
export function formatInstant(iso: string | null): string {
  if (iso === null) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  return at.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

/**
 * The role, in Japanese, with the wire value kept alongside.
 *
 * Both halves earn their place. The Japanese word is what the screen is for; the ASCII value is
 * what `PATCH /admin/users/:id` accepts, what the audit log records in `user.role_change`, and what
 * `packages/shared/src/capabilities.ts` keys its table on — so an administrator reading a log entry
 * that says `Researcher` must be able to find that word on the screen that set it.
 */
export function roleLabel(role: string): string {
  switch (role) {
    case 'Admin':
      return `管理者 (Admin)`
    case 'Researcher':
      return `研究者 (Researcher)`
    case 'Viewer':
      return `閲覧者 (Viewer)`
    default:
      // An unknown role is shown as-is rather than mapped to a default. A row whose role this build
      // does not recognise is exactly the row an administrator needs to see truthfully.
      return role
  }
}

export type QuotaLevel = 'unknown' | 'ok' | 'warning' | 'critical' | 'over'

export interface QuotaPressure {
  level: QuotaLevel
  /** Used ÷ limit, clamped to [0, 1] for the meter. Null when there is no meaningful limit. */
  ratio: number | null
  /** The same figure as a percentage string, or `—`. */
  percentText: string
  /** Words, never colour alone — the level has to survive a monochrome screen. */
  label: string
}

/** Above this share of the ceiling a user is close enough to it that an upload will start failing. */
const WARNING_RATIO = 0.8
const CRITICAL_RATIO = 0.95

/**
 * How close a user is to their storage ceiling.
 *
 * `bytesReserved` is included in the numerator on purpose. `docs/cloud-data-model.md` is explicit
 * that the reservation is what the *next* upload has to fit around: the reserving UPDATE tests
 * `bytes_used + bytes_reserved + declared <= bytes_limit`, so a user with a stuck reservation has
 * less room than `bytesUsed` alone suggests. Reporting the optimistic figure would make the screen
 * disagree with the server at exactly the moment somebody is asking why their upload failed.
 */
export function quotaPressure(used: number, reserved: number, limit: number): QuotaPressure {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { level: 'unknown', ratio: null, percentText: '—', label: '上限不明' }
  }
  const committed = Math.max(0, used) + Math.max(0, reserved)
  const raw = committed / limit
  const ratio = Math.min(1, Math.max(0, raw))
  const percentText = `${(raw * 100).toFixed(raw >= 10 ? 0 : 1)}%`
  if (raw >= 1) return { level: 'over', ratio, percentText, label: '上限超過' }
  if (raw >= CRITICAL_RATIO) return { level: 'critical', ratio, percentText, label: '上限間近' }
  if (raw >= WARNING_RATIO) return { level: 'warning', ratio, percentText, label: '残りわずか' }
  return { level: 'ok', ratio, percentText, label: '余裕あり' }
}

/**
 * The bytes a user could still store.
 *
 * Never negative: a limit lowered below current usage is a legitimate state — `PUT /admin/quotas`
 * refuses to create one, but usage can also be corrected upwards by a finalise — and a screen
 * showing `-40 MiB of free space` reads as a bug rather than as "this account is over".
 */
export function remainingBytes(used: number, reserved: number, limit: number): number {
  return Math.max(0, limit - Math.max(0, used) - Math.max(0, reserved))
}

/**
 * Parse a human-typed storage limit into bytes.
 *
 * The quota endpoint takes an integer number of bytes, which is the right wire format and the wrong
 * thing to ask a person to type: `2147483648` is four keystrokes away from an order-of-magnitude
 * mistake in either direction, and the mistake is silent. So the field accepts a number and a unit
 * and does the arithmetic here, where it can be tested.
 */
export const QUOTA_UNITS = { MiB: 1024 * 1024, GiB: 1024 * 1024 * 1024 } as const

export type QuotaUnit = keyof typeof QUOTA_UNITS

export function quotaBytesFrom(amount: string, unit: QuotaUnit): number | null {
  const parsed = Number(amount.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return null
  const bytes = Math.round(parsed * QUOTA_UNITS[unit])
  if (!Number.isSafeInteger(bytes)) return null
  return bytes
}

/** The inverse, for pre-filling the field with what the user's limit already is. */
export function quotaAmountOf(bytes: number, unit: QuotaUnit): string {
  const value = bytes / QUOTA_UNITS[unit]
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
