/**
 * Joining the two halves of "who is in this deployment".
 *
 * The console needs one row per user carrying identity, role, account status and storage. No route
 * returns that: `GET /admin/users` knows the first three and nothing about bytes, and
 * `GET /admin/storage` knows the bytes and joins only `user.name` and `user.role` for labelling. The
 * two are also scoped differently — the storage report returns the top two hundred rows *by usage*
 * and only for users who have a `quota_usage` row at all, which is created on first use — so a user
 * who has never uploaded anything is present in one listing and absent from the other.
 *
 * That asymmetry is why the merge is a left join from the user listing rather than an inner one, and
 * why `storage` is nullable rather than defaulted to zeros. "This account has stored nothing" and
 * "the storage report did not reach this account" are different facts, and an operator deciding
 * whether to raise somebody's quota needs to be able to tell them apart.
 *
 * ## The display name is the identity
 *
 * There is no email address in this system. `worker/auth/identity.ts` mints a synthetic
 * `@aat.invalid` address because the auth framework's data model demands a unique one, and no route
 * returns it — `toPublicUser` drops it, with a comment saying that an admin console is exactly where
 * it would start being mistaken for an identity. This module keeps that promise: the only
 * machine-readable handle here is the opaque user id, and {@link recordIdLabel} exists so that when
 * a screen does show it, it is labelled as an internal record identifier and never as a way to
 * contact or address a person.
 */

import type { AdminUser, StorageReport } from '../cloud/gateway.ts'

export interface UserStorage {
  bytesUsed: number
  bytesReserved: number
  bytesLimit: number
  objectCount: number
}

export interface AdminUserRow {
  id: string
  displayName: string
  role: string
  /** `banned` on the wire. Presented as 停止 — a disabled account, not a deleted one. */
  banned: boolean
  createdAt: string
  /** Null when the storage report has no row for this user; see the module note. */
  storage: UserStorage | null
  /**
   * True when this user's ceiling differs from the one most of the deployment has. See
   * {@link prevailingQuotaLimit} for why that is the comparison rather than a hard-coded default.
   */
  quotaOverridden: boolean
}

/**
 * The storage limit most accounts in this deployment have.
 *
 * Used as the baseline that makes an override visible. The obvious alternative — comparing against
 * `AAT_DEFAULT_QUOTA_BYTES` — is not available and should not be faked: the default is a Worker
 * configuration var, it is not returned by any route, and hard-coding 1 GiB here would mean that the
 * day an operator changes it every user in the console is labelled "overridden". The modal limit is
 * derived from the data actually on screen, so it follows the deployment automatically.
 *
 * Ties are broken towards the *larger* limit, arbitrarily but stably, so that two equally common
 * limits do not make the label flicker between page loads.
 */
export function prevailingQuotaLimit(perUser: StorageReport['perUser']): number | null {
  if (perUser.length === 0) return null
  const counts = new Map<number, number>()
  for (const row of perUser) counts.set(row.bytesLimit, (counts.get(row.bytesLimit) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [limit, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && limit > best)) {
      best = limit
      bestCount = count
    }
  }
  return best
}

/**
 * One row per user, with storage attached where the report has it.
 *
 * Driven by the user listing rather than by the storage report because the user listing is the
 * authoritative membership of the deployment. A storage row for a user the listing did not return —
 * possible, since the two are paginated independently — is *not* dropped silently: it is appended
 * with the name and role the storage report itself carries, so a heavy consumer cannot fall off the
 * screen merely because they were on the second page of users.
 */
export function mergeAdminUsers(
  users: readonly AdminUser[],
  perUser: StorageReport['perUser'],
): AdminUserRow[] {
  const storageById = new Map<string, StorageReport['perUser'][number]>()
  for (const row of perUser) storageById.set(row.userId, row)

  const prevailing = prevailingQuotaLimit(perUser)
  const seen = new Set<string>()

  const rows: AdminUserRow[] = users.map((user) => {
    seen.add(user.id)
    const storage = storageById.get(user.id)
    return {
      id: user.id,
      displayName: user.displayName,
      role: user.role,
      banned: user.banned,
      createdAt: user.createdAt,
      storage:
        storage === undefined
          ? null
          : {
              bytesUsed: storage.bytesUsed,
              bytesReserved: storage.bytesReserved,
              bytesLimit: storage.bytesLimit,
              objectCount: storage.objectCount,
            },
      quotaOverridden: storage !== undefined && prevailing !== null && storage.bytesLimit !== prevailing,
    }
  })

  for (const storage of perUser) {
    if (seen.has(storage.userId)) continue
    rows.push({
      id: storage.userId,
      displayName: storage.displayName,
      role: storage.role,
      // Not knowable from the storage report. `false` is the safe reading: a screen that showed an
      // account as 停止 on no evidence would be inventing a security state.
      banned: false,
      createdAt: '',
      storage: {
        bytesUsed: storage.bytesUsed,
        bytesReserved: storage.bytesReserved,
        bytesLimit: storage.bytesLimit,
        objectCount: storage.objectCount,
      },
      quotaOverridden: prevailing !== null && storage.bytesLimit !== prevailing,
    })
  }

  return rows
}

export type AdminUserSort = 'storage' | 'name' | 'role'

const ROLE_ORDER: Readonly<Record<string, number>> = { Admin: 0, Researcher: 1, Viewer: 2 }

/**
 * Order the rows.
 *
 * `storage` is the default and descending, for the same reason `GET /admin/storage` orders that way:
 * the question this table answers most often is "who is consuming the account", and that is always
 * a question about the top of the list. Every comparator falls back to the display name so the order
 * is total — two users with no storage must not swap places between renders.
 */
export function sortAdminUsers(rows: readonly AdminUserRow[], sort: AdminUserSort): AdminUserRow[] {
  const byName = (left: AdminUserRow, right: AdminUserRow): number =>
    left.displayName.localeCompare(right.displayName, 'ja') || left.id.localeCompare(right.id)

  return [...rows].sort((left, right) => {
    if (sort === 'name') return byName(left, right)
    if (sort === 'role') {
      const order = (ROLE_ORDER[left.role] ?? 99) - (ROLE_ORDER[right.role] ?? 99)
      return order !== 0 ? order : byName(left, right)
    }
    const used = (right.storage?.bytesUsed ?? 0) - (left.storage?.bytesUsed ?? 0)
    return used !== 0 ? used : byName(left, right)
  })
}

/**
 * Narrow by display name or by record id.
 *
 * Case-folded, and matched against the id as well as the name because the id is what an audit entry
 * names. Following an entry that says `actorUserId: 01J…` to the person who made it is the single
 * most common reason to open the user list from the log.
 */
export function filterAdminUsers(rows: readonly AdminUserRow[], search: string): AdminUserRow[] {
  const needle = search.trim().toLocaleLowerCase('ja')
  if (needle === '') return [...rows]
  return rows.filter(
    (row) =>
      row.displayName.toLocaleLowerCase('ja').includes(needle) ||
      row.id.toLocaleLowerCase('ja').includes(needle),
  )
}

/** How many of these accounts are disabled. Shown beside the total; a zero is a real answer. */
export function countDisabled(rows: readonly AdminUserRow[]): number {
  return rows.reduce((total, row) => total + (row.banned ? 1 : 0), 0)
}

/** How many accounts hold each role, for the overview's membership line. */
export function countByRole(rows: readonly AdminUserRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.role, (counts.get(row.role) ?? 0) + 1)
  return counts
}

/**
 * The opaque user id, labelled as what it is.
 *
 * Every screen that shows an id shows it through this, so the console never presents an identifier
 * as though it were a name or an address. It is a record id: it appears in the audit log, it is what
 * `ownerUserId=` filters on, and it is the only thing that can be typed into a recovery invitation.
 */
export function recordIdLabel(userId: string): string {
  return `内部ID ${userId}`
}

/**
 * The most recent moment any of a user's passkeys was used.
 *
 * The closest thing this deployment has to "last active", and the difference matters enough to say
 * out loud wherever it is shown: it is the last *authentication*, not the last request. A session
 * cookie outlives the ceremony that created it, so somebody who signed in a week ago and has been
 * working ever since reads as a week idle. There is no route that reports session activity, so this
 * is the honest upper bound rather than a guess dressed up as a fact.
 */
export function lastPasskeyUse(passkeys: ReadonlyArray<{ lastUsedAt: string | null }>): string | null {
  let latest: string | null = null
  for (const key of passkeys) {
    if (key.lastUsedAt === null) continue
    if (latest === null || key.lastUsedAt > latest) latest = key.lastUsedAt
  }
  return latest
}
