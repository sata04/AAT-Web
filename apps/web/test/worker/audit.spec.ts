/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The audit log: what it must record, and what it must never contain.
 *
 * An audit table is one of the most-exported tables a system has — it ends up in a SIEM, in a CSV
 * an administrator mailed themselves, in a support ticket. So "never records a raw token" is not a
 * nice-to-have; it is the difference between an audit trail and a credential dump.
 */

import { describe, expect, it } from 'vitest'
import { auditLogs } from '../../worker/db/schema.ts'
import { redactDetails } from '../../worker/services/audit.ts'
import { apiFetch, createRevision, createRun, createUser, db, posterSpec } from './helpers/client.ts'

interface AuditEntry {
  action: string
  actorUserId: string | null
  targetType: string | null
  targetId: string | null
  details: Record<string, unknown> | null
}

async function entriesFor(adminCookie: string, action?: string): Promise<AuditEntry[]> {
  const query = action ? `?action=${encodeURIComponent(action)}&limit=200` : '?limit=200'
  const response = await apiFetch(`/api/v1/admin/audit${query}`, { cookie: adminCookie })
  expect(response.status).toBe(200)
  const body = (await response.json()) as { entries: AuditEntry[] }
  return body.entries
}

describe('audit log', () => {
  it('records the sensitive actions of a full research workflow', async () => {
    const admin = await createUser({ role: 'Admin' })
    const user = await createUser()
    const runId = await createRun(user)
    const revisionId = await createRevision(user, runId)
    await apiFetch(`/api/v1/revisions/${revisionId}/poster/auto`, {
      method: 'POST',
      cookie: user.cookie,
      body: JSON.stringify({ spec: posterSpec(revisionId) }),
    })

    const actions = new Set((await entriesFor(admin.cookie)).map((entry) => entry.action))
    for (const expected of [
      'invitation.claim',
      'user.register',
      'run.create',
      'revision.create',
      'poster.render',
    ]) {
      expect(actions).toContain(expected)
    }
  })

  it('records administrative actions with the actor that performed them', async () => {
    const admin = await createUser({ role: 'Admin' })
    const target = await createUser({ role: 'Viewer' })

    const promoted = await apiFetch(`/api/v1/admin/users/${target.userId}`, {
      method: 'PATCH',
      cookie: admin.cookie,
      body: JSON.stringify({ role: 'Researcher' }),
    })
    expect(promoted.status).toBe(200)

    const entries = await entriesFor(admin.cookie, 'user.role_change')
    const entry = entries.find((candidate) => candidate.targetId === target.userId)
    expect(entry?.actorUserId).toBe(admin.userId)
    expect(entry?.details).toMatchObject({ from: 'Viewer', to: 'Researcher' })
  })

  it('records a failed redemption without recording what was presented', async () => {
    const admin = await createUser({ role: 'Admin' })
    const secret = 'super-secret-token-value-that-must-never-be-logged'

    await apiFetch('/api/auth/aat/invitation/redeem', {
      method: 'POST',
      body: JSON.stringify({ token: secret }),
    })

    const entries = await entriesFor(admin.cookie, 'invitation.redeem_failed')
    expect(entries.length).toBeGreaterThan(0)

    const serialised = JSON.stringify(entries)
    expect(serialised).not.toContain(secret)
    // Not the hash either: a hash of a 256-bit token is not a secret, but storing it turns the
    // audit log into a lookup table for the invitations table.
    expect(entries[0]?.details).toMatchObject({ reason: 'INVITE_INVALID' })
  })

  it('never contains an invitation token, in any row', async () => {
    const admin = await createUser({ role: 'Admin' })

    const created = await apiFetch('/api/v1/admin/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({
        kind: 'registration',
        role: 'Researcher',
        displayName: '新しい研究者',
        ttlHours: 24,
      }),
    })
    const body = (await created.json()) as { invitation: { id: string; token: string } }

    // Straight at the table, not through the API: the guarantee is about what is stored.
    const rows = await db().select().from(auditLogs)
    const serialised = JSON.stringify(rows)
    expect(serialised).not.toContain(body.invitation.token)
    // The invitation is identified by its id, which is exactly what an operator needs.
    expect(serialised).toContain(body.invitation.id)
  })

  it('redacts anything that looks like a credential, whatever a caller passes', async () => {
    const redacted = redactDetails({
      token: 'plaintext',
      registrationContext: 'plaintext',
      challenge: 'plaintext',
      sessionCookie: 'plaintext',
      runId: '01RUN',
      byteSize: 42,
    })
    expect(redacted).toEqual({
      token: '[redacted]',
      registrationContext: '[redacted]',
      challenge: '[redacted]',
      sessionCookie: '[redacted]',
      runId: '01RUN',
      byteSize: 42,
    })
  })

  it('is readable only by a capability, not by a role check', async () => {
    const researcher = await createUser({ role: 'Researcher' })
    const response = await apiFetch('/api/v1/admin/audit', { cookie: researcher.cookie })
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { details?: { required?: string } } }
    expect(body.error.details?.required).toBe('audit:read')
  })
})

describe('invitation listing', () => {
  it('never returns a token or its hash', async () => {
    const admin = await createUser({ role: 'Admin' })
    const created = await apiFetch('/api/v1/admin/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ kind: 'registration', role: 'Viewer', displayName: 'x', ttlHours: 1 }),
    })
    const body = (await created.json()) as { invitation: { token: string } }

    const listed = await apiFetch('/api/v1/admin/invitations', { cookie: admin.cookie })
    const text = await listed.text()
    expect(text).not.toContain(body.invitation.token)
    expect(text).not.toContain('tokenHash')
  })
})
