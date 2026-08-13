/**
 * The admin console's own navigation, as data.
 *
 * The seven sections are a fixed table rather than JSX scattered through a component for the same
 * reason `src/router/Router.tsx` keeps `ROUTES` as a table: which screens exist, which route each
 * one answers, and what capability each one needs are three facts that must agree, and they only
 * stay in agreement if they are written down once. A link rendered without its capability, or a
 * capability checked without a link, is precisely the class of drift a table prevents.
 *
 * ## The capability on each row is presentation, not enforcement
 *
 * Hiding a section a caller cannot use is a courtesy: it stops the console offering a door that
 * answers `FORBIDDEN`. It is emphatically **not** a security boundary. Every route these screens
 * call re-checks the capability in `worker/middleware/authorize.ts`, and a caller who edits their
 * own JavaScript to reveal the Users screen gets a screen that cannot load anything. That is the
 * intended outcome: the Worker is the authority, the client is a convenience, and no screen here is
 * written as though the reverse could be true.
 *
 * The capability named on each row is the one its *primary* data source demands, taken from the
 * route handlers in `worker/routes/admin.ts`. Where a screen reads two sources with different
 * capabilities — the overview reads users, storage and the audit log — the screen asks for each
 * one separately and degrades section by section rather than refusing wholesale.
 */

import type { Capability } from '@aat/shared'
import { hasCapability } from '@aat/shared'
import type { RouteName } from '../router/Router.tsx'

export interface AdminSection {
  /** The router's name for this screen, so the current item can be marked without string paths. */
  readonly route: RouteName
  readonly path: string
  readonly label: string
  /**
   * The capability the section's primary data source requires. A caller without it is not shown
   * the link — and would be refused by the Worker if they reached the path anyway.
   */
  readonly capability: Capability
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  { route: 'admin', path: '/admin', label: '概要', capability: 'quota:manage' },
  { route: 'admin-users', path: '/admin/users', label: '利用者', capability: 'user:manage' },
  {
    route: 'admin-invitations',
    path: '/admin/invitations',
    label: '招待',
    capability: 'invitation:manage',
  },
  { route: 'admin-runs', path: '/admin/runs', label: '実験と保存容量', capability: 'quota:manage' },
  {
    route: 'admin-renderer',
    path: '/admin/renderer',
    label: 'ポスターレンダラー',
    capability: 'quota:manage',
  },
  { route: 'admin-audit', path: '/admin/audit', label: '監査ログ', capability: 'audit:read' },
  { route: 'admin-settings', path: '/admin/settings', label: '設定', capability: 'quota:manage' },
]

/** The sections this caller is offered. Order is preserved: the console reads the same every time. */
export function visibleAdminSections(capabilities: readonly Capability[]): readonly AdminSection[] {
  return ADMIN_SECTIONS.filter((section) => hasCapability(capabilities, section.capability))
}

/**
 * Does this caller have any business in the console at all?
 *
 * Used to choose between "you are not signed in", "this account is not an administrator" and the
 * console itself. The three states need different words: the second is not a failure the reader can
 * fix by signing in again, and telling them to try would be a loop.
 */
export function hasAnyAdminCapability(capabilities: readonly Capability[]): boolean {
  return ADMIN_SECTIONS.some((section) => hasCapability(capabilities, section.capability))
}
