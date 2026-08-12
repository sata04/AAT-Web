/// <reference path="../../worker-configuration.d.ts" />

/**
 * The one place authorization happens.
 *
 * Three questions, asked in this order, by this module and nowhere else:
 *
 *   1. **Who is this?** `requireSession` verifies the Better Auth session cookie and loads the
 *      user. No session, no request.
 *   2. **May they do this kind of thing?** `requireCapability` checks a capability from
 *      @aat/shared's vocabulary. Routes name capabilities; they never compare role strings. A
 *      `role === 'admin'` sprinkled through handlers is how an authorization model rots: the day a
 *      fourth role appears, every one of those comparisons is a bug, and the compiler cannot find
 *      them.
 *   3. **May they do it to THIS?** `requireOwnedRun` / `requireOwnedRevision` / `requireOwnedObject`
 *      resolve the resource and confirm the caller owns it. A capability is permission to act on
 *      your own data, never on someone else's.
 *
 * A resource that exists but belongs to someone else answers `RESOURCE_NOT_FOUND`, not `FORBIDDEN`.
 * `FORBIDDEN` on another user's id confirms that the id exists, which turns an id space into an
 * enumeration oracle.
 *
 * ## Administrators are not exempt from step 3
 *
 * `user:manage`, `invitation:manage`, `audit:read` and `quota:manage` let an administrator run the
 * deployment. None of them grants access to another researcher's measurements. Admin endpoints
 * that need to see other users' data see *metadata* — sizes, counts, run codes — never snapshot or
 * poster bytes. This is a research group's raw experimental data; "the admin can read everything"
 * is a policy that has to be chosen deliberately, and it has not been.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { and, eq, isNull } from 'drizzle-orm'
import { ApiError, type Capability, capabilitiesForRole, hasCapability, type Role, ROLES } from '@aat/shared'
import { getAuth } from '../auth/auth.ts'
import { type Database, getDatabase } from '../db/client.ts'
import { analysisRevisions, cloudObjects, runs } from '../db/schema.ts'

export interface Actor {
  userId: string
  role: Role
  capabilities: readonly Capability[]
  sessionId: string
  displayName: string
}

export interface AppEnv {
  Bindings: Env
  Variables: {
    actor: Actor
    db: Database
  }
}

export type AppContext = Context<AppEnv>

function normaliseRole(role: unknown): Role {
  // An unrecognised role string is treated as the least privileged role rather than as an error:
  // failing closed here keeps a hand-edited database row from escalating instead of breaking.
  return typeof role === 'string' && (ROLES as readonly string[]).includes(role) ? (role as Role) : 'Viewer'
}

/** Attach the Drizzle handle for the rest of the request. */
export const withDatabase: MiddlewareHandler<AppEnv> = async (context, next) => {
  context.set('db', getDatabase(context.env))
  await next()
}

/**
 * Verify the session and attach the actor.
 *
 * Session verification is Better Auth's `getSession`, which validates the signed cookie, checks
 * expiry, and — because the Admin plugin is installed — rejects a banned user's session.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (context, next) => {
  const auth = getAuth(context.env)
  const session = await auth.api.getSession({ headers: context.req.raw.headers })
  if (!session) {
    throw new ApiError('AUTH_REQUIRED')
  }
  const role = normaliseRole((session.user as { role?: unknown }).role)
  context.set('actor', {
    userId: session.user.id,
    role,
    capabilities: capabilitiesForRole(role),
    sessionId: session.session.id,
    displayName: session.user.name,
  })
  await next()
}

/** Require one capability. Compose after {@link requireSession}. */
export function requireCapability(capability: Capability): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const actor = context.get('actor')
    if (!actor || !hasCapability(actor.capabilities, capability)) {
      throw new ApiError('FORBIDDEN', { details: { required: capability } })
    }
    await next()
  }
}

/** Resolve a run the caller owns, or report it as absent. */
export async function requireOwnedRun(context: AppContext, runId: string) {
  const db = context.get('db')
  const actor = context.get('actor')
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!run || run.ownerUserId !== actor.userId) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return run
}

/** Resolve a revision the caller owns, or report it as absent. */
export async function requireOwnedRevision(context: AppContext, revisionId: string) {
  const db = context.get('db')
  const actor = context.get('actor')
  const [revision] = await db
    .select()
    .from(analysisRevisions)
    .where(eq(analysisRevisions.id, revisionId))
    .limit(1)
  if (!revision || revision.ownerUserId !== actor.userId) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return revision
}

/** Resolve a stored object the caller owns, or report it as absent. */
export async function requireOwnedObject(context: AppContext, objectId: string) {
  const db = context.get('db')
  const actor = context.get('actor')
  const [object] = await db
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.id, objectId), isNull(cloudObjects.deletedAt)))
    .limit(1)
  if (!object || object.ownerUserId !== actor.userId) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return object
}
