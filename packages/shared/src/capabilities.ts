/**
 * Authorization vocabulary shared by the browser app and the Worker.
 *
 * `Capability` is the fine-grained permission the server actually checks; `Role` is the coarse
 * label shown in the UI and assigned to a user. `ROLE_CAPABILITIES` is the single source of
 * truth mapping one to the other — server-side checks should test capabilities
 * (`hasCapability`), not compare role strings, so a future role split doesn't require touching
 * every call site.
 *
 * ## Two kinds of capability
 *
 * Most entries below answer *"may this user do this kind of thing at all?"* — `analysis:create`,
 * `poster:generate`, `raw:download`. On their own they say nothing about **whose** data is being
 * acted on: historically they were permission over your own data and nothing else.
 *
 * The `workspace:*` entries answer the other half of that question: *"whose work may this user
 * reach?"*. They exist because on 2026-08-13 the repository owner decided that this deployment is
 * one research team's shared workspace — everybody who can register is a member of it — so a
 * signed-in researcher should be able to see and reuse a colleague's analysis rather than only
 * their own. Keeping that as three named capabilities rather than a `role === 'Admin'` test
 * scattered through the Worker is what lets the whole policy be read off one table.
 *
 * The prefix is `workspace:` rather than `analysis:` deliberately. `analysis:read` is "may look at
 * analyses"; `workspace:read` is "may look at *other members'* analyses". They compose — the
 * Worker checks the first as a route capability and the second as the reach of the resolver that
 * loads the row — and a name that conflated them would make it impossible to grant one without
 * the other, which is exactly what a Viewer needs.
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
  /**
   * May read any member's work in this deployment: run metadata, revisions, metrics, poster
   * figures, snapshot bytes and original-CSV backups. Read *only* — it never implies a write, and
   * generating a poster from someone else's revision needs it precisely because a poster is
   * derived from a revision without changing it.
   */
  'workspace:read',
  /**
   * May annotate any member's work: the memo, the tags and the project a run is filed under.
   * Annotation is separated from reading because the two answers genuinely differ for a role that
   * should be able to look at a colleague's measurement without relabelling it.
   */
  'workspace:annotate',
  /**
   * May perform destructive actions on any member's work: deleting a run, and uploading or
   * deleting the original-CSV backup attached to one. Named `destroy` rather than `write` because
   * every action it guards either removes data or overwrites raw measurement bytes that cannot be
   * recomputed — it is the capability whose blast radius is irreversible.
   */
  'workspace:destroy',
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
  // Destroying a colleague's experiment is not a peer action. A Researcher can read and annotate
  // any member's work; only an administrator can delete it or replace its raw bytes, so an
  // accidental — or resentful — deletion of somebody else's measurement is not one click away.
  'workspace:destroy',
  'user:manage',
  'invitation:manage',
  'audit:read',
  'quota:manage',
]

/**
 * Viewers are read-only *and* see only their own runs: they hold no `workspace:*` capability, so
 * every resolver in the Worker refuses them another member's row. A Viewer is the role given to
 * someone who should be able to look at what they were given and nothing else, which stops being
 * true the moment they can reach the rest of the team's measurements.
 */
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
