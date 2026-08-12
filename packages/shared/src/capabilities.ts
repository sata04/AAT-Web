/**
 * Authorization vocabulary shared by the browser app and the Worker.
 *
 * `Capability` is the fine-grained permission the server actually checks; `Role` is the coarse
 * label shown in the UI and assigned to a user. `ROLE_CAPABILITIES` is the single source of
 * truth mapping one to the other — server-side checks should test capabilities
 * (`hasCapability`), not compare role strings, so a future role split doesn't require touching
 * every call site.
 */

export const CAPABILITIES = [
  'analysis:read',
  'analysis:create',
  'analysis:update',
  'analysis:delete',
  'cloud:read',
  'cloud:write',
  'raw:upload',
  'raw:download',
  'raw:delete',
  'poster:generate',
  'project:create',
  'project:share',
  'user:manage',
  'invitation:manage',
  'audit:read',
  'quota:manage',
] as const

export type Capability = (typeof CAPABILITIES)[number]

export const ROLES = ['Admin', 'Researcher', 'Viewer'] as const

export type Role = (typeof ROLES)[number]

/** Capabilities reserved for administration; every other capability is available to Researchers. */
const ADMIN_ONLY_CAPABILITIES: readonly Capability[] = [
  'user:manage',
  'invitation:manage',
  'audit:read',
  'quota:manage',
]

/** Viewers are read-only: they can look at analyses and cloud state, nothing else. */
const VIEWER_CAPABILITIES: readonly Capability[] = ['analysis:read', 'cloud:read']

export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  Viewer: VIEWER_CAPABILITIES,
  Researcher: CAPABILITIES.filter((capability) => !ADMIN_ONLY_CAPABILITIES.includes(capability)),
  Admin: CAPABILITIES,
}

export function capabilitiesForRole(role: Role): readonly Capability[] {
  return ROLE_CAPABILITIES[role]
}

export function hasCapability(capabilities: readonly Capability[], needed: Capability): boolean {
  return capabilities.includes(needed)
}

/** True only if every capability in `needed` is present. */
export function hasAllCapabilities(
  capabilities: readonly Capability[],
  needed: readonly Capability[],
): boolean {
  return needed.every((capability) => capabilities.includes(capability))
}
