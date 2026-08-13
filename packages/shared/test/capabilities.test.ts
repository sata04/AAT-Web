import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasAllCapabilities,
  hasCapability,
  ROLE_CAPABILITIES,
  ROLES,
} from '../src/capabilities.ts'

const ADMIN_ONLY = [
  // Destroying a colleague's experiment is not a peer action, so this sits with administration
  // rather than with the other two workspace capabilities.
  'workspace:destroy',
  'user:manage',
  'invitation:manage',
  'audit:read',
  'quota:manage',
]

describe('capabilities', () => {
  it('Viewer is read-only AND own-data-only: exactly analysis:read and cloud:read', () => {
    // No workspace:* capability, which is what keeps a Viewer's reach unchanged by the
    // shared-workspace policy: every resolver in the Worker refuses them another member's row.
    expect([...ROLE_CAPABILITIES.Viewer].sort()).toEqual(['analysis:read', 'cloud:read'])
  })

  it('Researcher has everything except the admin-only capabilities', () => {
    const researcher = ROLE_CAPABILITIES.Researcher
    for (const capability of ADMIN_ONLY) {
      expect(researcher).not.toContain(capability)
    }
    for (const capability of CAPABILITIES) {
      if (!ADMIN_ONLY.includes(capability)) {
        expect(researcher).toContain(capability)
      }
    }
  })

  it('a Researcher may read and annotate any member’s work, but never destroy it', () => {
    const researcher = ROLE_CAPABILITIES.Researcher
    expect(researcher).toContain('workspace:read')
    expect(researcher).toContain('workspace:annotate')
    expect(researcher).not.toContain('workspace:destroy')

    expect(ROLE_CAPABILITIES.Admin).toContain('workspace:destroy')
  })

  it('Admin has every capability', () => {
    expect([...ROLE_CAPABILITIES.Admin].sort()).toEqual([...CAPABILITIES].sort())
  })

  it('every role is covered and every capability is a plain string union member', () => {
    expect(ROLES).toEqual(['Admin', 'Researcher', 'Viewer'])
    for (const role of ROLES) {
      expect(ROLE_CAPABILITIES[role]).toBeDefined()
    }
  })

  it('hasCapability checks membership', () => {
    expect(hasCapability(capabilitiesForRole('Viewer'), 'analysis:read')).toBe(true)
    expect(hasCapability(capabilitiesForRole('Viewer'), 'analysis:create')).toBe(false)
    expect(hasCapability(capabilitiesForRole('Admin'), 'quota:manage')).toBe(true)
  })

  it('hasAllCapabilities requires every listed capability to be present', () => {
    const researcher = capabilitiesForRole('Researcher')
    expect(hasAllCapabilities(researcher, ['analysis:read', 'cloud:write'])).toBe(true)
    expect(hasAllCapabilities(researcher, ['analysis:read', 'user:manage'])).toBe(false)
    expect(hasAllCapabilities(researcher, [])).toBe(true)
  })
})
