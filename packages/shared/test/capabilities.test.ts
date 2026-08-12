import { describe, expect, it } from 'vitest'
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasAllCapabilities,
  hasCapability,
  ROLE_CAPABILITIES,
  ROLES,
} from '../src/capabilities.ts'

describe('capabilities', () => {
  it('Viewer is read-only: exactly analysis:read and cloud:read', () => {
    expect([...ROLE_CAPABILITIES.Viewer].sort()).toEqual(['analysis:read', 'cloud:read'])
  })

  it('Researcher has everything except the admin-only capabilities', () => {
    const researcher = ROLE_CAPABILITIES.Researcher
    const adminOnly = ['user:manage', 'invitation:manage', 'audit:read', 'quota:manage']
    for (const capability of adminOnly) {
      expect(researcher).not.toContain(capability)
    }
    for (const capability of CAPABILITIES) {
      if (!adminOnly.includes(capability)) {
        expect(researcher).toContain(capability)
      }
    }
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
