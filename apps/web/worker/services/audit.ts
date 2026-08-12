/**
 * The audit log.
 *
 * Append-only, and deliberately narrow: it records *that* a sensitive action happened, by whom, to
 * what, and from where — never the contents of the credential involved. `writeAuditLog` runs its
 * details through {@link redactDetails}, which drops any key whose name suggests a secret. That is
 * a backstop, not the design: callers are expected to pass an invitation's id, never its token.
 * Belt and braces, because an audit log is exactly the kind of table that gets exported, shipped
 * to a SIEM and read by more people than the database it lives in.
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
const FORBIDDEN_DETAIL_KEYS = /token|secret|password|challenge|credential|cookie|authorization/i

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
  details?: Record<string, unknown>
  headers?: Headers
}

export async function writeAuditLog(db: Database, entry: AuditEntry): Promise<void> {
  const details = entry.details ? JSON.stringify(redactDetails(entry.details)) : null
  await db.insert(auditLogs).values({
    id: newId(),
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    ipAddress: entry.headers?.get('cf-connecting-ip') ?? null,
    // Truncated: a user agent is diagnostic, and an unbounded client-controlled string in a table
    // that is read in bulk is a resource question as much as a correctness one.
    userAgent: entry.headers?.get('user-agent')?.slice(0, 256) ?? null,
    details,
    createdAt: new Date(),
  })
}
