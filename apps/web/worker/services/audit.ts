/**
 * The audit log.
 *
 * Append-only, and deliberately narrow: it records *that* a sensitive action happened, by whom, to
 * what, and from where — never the contents of the credential involved. `writeAuditLog` runs its
 * details through {@link redactDetails}, which drops any key whose name suggests a secret. That is
 * a backstop, not the design: callers are expected to pass an invitation's id, never its token.
 * Belt and braces, because an audit log is exactly the kind of table that gets exported, shipped
 * to a SIEM and read by more people than the database it lives in.
 *
 * ## Whose work was this done to?
 *
 * Since the shared-workspace policy of 2026-08-13 the actor is frequently not the owner: a
 * researcher may read a colleague's snapshot, and an administrator may delete their run. Recording
 * only `actorUserId` would make "who has been reading my measurements?" unanswerable, which is the
 * one question the widening created. So every entry about an owned resource carries
 * `targetOwnerUserId`, and {@link writeAuditLog} additionally tags the entry `crossUser: true` when
 * the two differ — so the cross-user subset is a filter rather than a join against four other
 * tables.
 */

import type { Database } from '../db/client.ts'
import { auditLogs } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'

export type AuditAction =
  | 'invitation.create'
  | 'invitation.revoke'
  | 'invitation.claim'
  | 'invitation.redeem'
  | 'invitation.redeem_failed'
  | 'user.register'
  | 'user.role_change'
  | 'user.ban'
  | 'user.unban'
  | 'user.delete'
  | 'passkey.register'
  | 'passkey.authenticate'
  | 'passkey.authenticate_failed'
  | 'passkey.delete'
  | 'passkey.recover'
  | 'run.create'
  | 'run.update'
  | 'run.delete'
  | 'revision.create'
  | 'snapshot.upload'
  | 'snapshot.download'
  | 'source.upload'
  | 'source.download'
  | 'source.delete'
  | 'poster.render'
  | 'poster.retry'
  | 'poster.download'
  | 'quota.update'
  | 'renderer.circuit_breaker'

/** Keys whose values must never reach the audit log, whatever a caller passes. */
const FORBIDDEN_DETAIL_KEYS =
  /token|secret|password|challenge|credential|cookie|authorization|registrationcontext|signature|assertion/i

export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (FORBIDDEN_DETAIL_KEYS.test(key)) {
      safe[key] = '[redacted]'
      continue
    }
    safe[key] = value
  }
  return safe
}

export interface AuditEntry {
  actorUserId: string | null
  action: AuditAction
  targetType?: string
  targetId?: string
  /**
   * The member whose work this action touched. Pass it for every action on a run, revision,
   * snapshot, source backup or poster — including the ordinary case where it equals the actor,
   * because an entry that only names an owner when the access was unusual makes the *absence* of
   * the field the interesting signal, and absences are not something a log can prove.
   */
  targetOwnerUserId?: string | null
  details?: Record<string, unknown>
  headers?: Headers
}

export async function writeAuditLog(db: Database, entry: AuditEntry): Promise<void> {
  const targetOwnerUserId = entry.targetOwnerUserId ?? null
  const crossUser = targetOwnerUserId !== null && targetOwnerUserId !== entry.actorUserId
  const rawDetails = crossUser ? { ...entry.details, crossUser: true } : entry.details
  const details = rawDetails ? JSON.stringify(redactDetails(rawDetails)) : null
  await db.insert(auditLogs).values({
    id: newId(),
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    targetOwnerUserId,
    ipAddress: entry.headers?.get('cf-connecting-ip') ?? null,
    // Truncated: a user agent is diagnostic, and an unbounded client-controlled string in a table
    // that is read in bulk is a resource question as much as a correctness one.
    userAgent: entry.headers?.get('user-agent')?.slice(0, 256) ?? null,
    details,
    createdAt: new Date(),
  })
}
