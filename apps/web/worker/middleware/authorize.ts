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
 *   3. **May they do it to THIS?** `requireRun` / `requireRevision` / `requirePosterFigure` /
 *      `requireObjectAccess` resolve the resource and confirm the caller reaches it at the level
 *      the route asks for — `read`, `annotate`, `destroy` or `own`. The level is spelled at every
 *      call site, so what a route does to somebody else's data is legible from the call itself.
 *
 * A resource that exists but the caller may not reach answers `RESOURCE_NOT_FOUND`, not
 * `FORBIDDEN`. `FORBIDDEN` on another user's id confirms that the id exists, which turns an id
 * space into an enumeration oracle. That matters *more* under the policy below, not less: a Viewer
 * is the one role still confined to its own runs, and a 403 would tell them precisely which run
 * ids the rest of the team holds.
 *
 * ## This deployment is one research team's shared workspace (decided 2026-08-13)
 *
 * This module used to say that "the admin can read everything" was a policy that had to be chosen
 * deliberately, and had not been. It has now been chosen, deliberately, by the repository owner,
 * and this is the record of it.
 *
 * Registration here is by invitation only, and every invitation is issued by the owner of the
 * deployment to a member of their own research group. There is no second tenant and no way to
 * become a user without someone deciding you are a colleague. Under those conditions, walling each
 * researcher off from every other researcher's measurements did not protect anyone from anything —
 * it just meant a group that shares a drop tower could not share the analyses of the drops.
 *
 * So the reach of a signed-in caller is now:
 *
 * | Action                                        | Owner | Researcher | Admin | Viewer |
 * | --------------------------------------------- | ----- | ---------- | ----- | ------ |
 * | Read runs, revisions, metrics, posters         | yes   | yes        | yes   | no     |
 * | Read/download snapshots and original CSVs      | yes   | yes        | yes   | no     |
 * | Generate a poster from a revision              | yes   | yes        | yes   | no     |
 * | Edit memo, tags, project                       | yes   | yes        | yes   | no     |
 * | Delete a run, upload/delete an original CSV    | yes   | no         | yes   | no     |
 * | Create a revision, upload a snapshot           | yes   | no         | no    | no     |
 *
 * Three things about that table are load-bearing:
 *
 *  - **It is expressed as capabilities, not as roles.** `workspace:read`, `workspace:annotate` and
 *    `workspace:destroy` in @aat/shared are what widen a caller's reach; this module maps an access
 *    level to one of them and asks `hasCapability`. Adding a fourth role means editing one table in
 *    @aat/shared, not auditing every handler again.
 *  - **A Viewer is unchanged.** Viewers hold no `workspace:*` capability, so every resolver below
 *    still refuses them anything they do not own. Their read scope did not widen; everyone else's
 *    did.
 *  - **The last row is deliberately narrower than the rest.** Reading and annotating a colleague's
 *    run leaves the analytical record alone. *Creating* a revision on it, or filing a snapshot
 *    under one, writes into somebody else's provenance chain — "who analysed this, with what
 *    settings" would stop having one answer. Nobody but the owner may do that, administrator
 *    included, because there is no operational need for it and an audit trail that cannot be
 *    trusted is worse than a missing feature.
 *
 * ## Administrators are still not exempt from step 3
 *
 * `user:manage`, `invitation:manage`, `audit:read` and `quota:manage` let an administrator run the
 * deployment; they do not by themselves reach a single byte of research data. An administrator
 * reads a colleague's snapshot through `workspace:read` and the ordinary member routes — where the
 * read is resolved, audited and attributed like anyone else's — never through the admin surface,
 * which continues to serve metadata (sizes, counts, names) and never object bytes.
 */

import { ApiError, type Capability, capabilitiesForRole, hasCapability, ROLES, type Role } from '@aat/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'
import { getAuth } from '../auth/auth.ts'
import { type Database, getDatabase } from '../db/client.ts'
import { analysisRevisions, posterFigures, runs } from '../db/schema.ts'

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

/* ------------------------------------------------------------------------------------------- */
/* Reach: what a caller may do to a resource somebody else owns                                  */
/* ------------------------------------------------------------------------------------------- */

/**
 * How far into another member's work a route needs to go.
 *
 * Every resolver takes one of these, so a route's intent is stated where it acts rather than
 * inferred from the HTTP verb. `DELETE` is not automatically destructive (deleting a *tag* is an
 * annotation) and `POST` is not automatically a write to the target (rendering a poster reads a
 * revision), which is exactly why the level is named rather than derived.
 */
export type ResourceAccess =
  /** Look at it, or derive something from it that leaves it unchanged. */
  | 'read'
  /** Change how it is labelled and filed: memo, tags, project. */
  | 'annotate'
  /** Remove it, or replace raw bytes that cannot be recomputed. */
  | 'destroy'
  /**
   * The owner and nobody else. No capability widens this level — it is what guards writes into
   * another member's analytical record, which no role is granted.
   */
  | 'own'

/** The capability that widens each level beyond the owner. `own` has none, on purpose. */
const ACCESS_CAPABILITY: Readonly<Record<ResourceAccess, Capability | null>> = {
  read: 'workspace:read',
  annotate: 'workspace:annotate',
  destroy: 'workspace:destroy',
  own: null,
}

/** Does this actor reach a resource owned by `ownerUserId` at `access`? */
export function reachesResource(actor: Actor, ownerUserId: string, access: ResourceAccess): boolean {
  if (actor.userId === ownerUserId) return true
  const capability = ACCESS_CAPABILITY[access]
  return capability !== null && hasCapability(actor.capabilities, capability)
}

/**
 * Refuse — as an absence — a resource the caller does not reach.
 *
 * Use this for rows that hang off a resource already resolved by one of the functions below
 * (a `cloud_objects` row found by its run, say). The answer is `RESOURCE_NOT_FOUND` whatever the
 * reason, so "exists but not yours" and "does not exist" stay indistinguishable.
 */
export function requireObjectAccess(context: AppContext, ownerUserId: string, access: ResourceAccess): void {
  if (!reachesResource(context.get('actor'), ownerUserId, access)) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Resolvers                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Resolve a live run the caller reaches at `access`, or report it as absent. */
export async function requireRun(context: AppContext, runId: string, access: ResourceAccess) {
  const db = context.get('db')
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), isNull(runs.deletedAt)))
    .limit(1)
  if (!run || !reachesResource(context.get('actor'), run.ownerUserId, access)) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return run
}

/**
 * Resolve a revision of a live run the caller reaches at `access`, or report it as absent.
 *
 * The join to `runs` is the part that matters. A revision carries its own `owner_user_id`, so
 * checking that alone looks sufficient — but a run is deleted by stamping `deleted_at` on the run
 * row, and nothing propagates that to the revisions hanging off it. Without the join, every
 * revision of a deleted run stays individually addressable by id: `GET /revisions/:id` would keep
 * answering with its metrics, config hash and provenance after the user asked for the run to be
 * gone.
 *
 * That is not a data leak — under the workspace policy a colleague could have read it anyway. It
 * is worse in a quieter way: it makes deletion mean something different depending on which id you
 * happen to hold, which is exactly the kind of ambiguity a deletion guarantee cannot afford.
 * `requireRun` has always filtered `deleted_at`; this is the same rule reached through the other
 * door, and it holds for an administrator exactly as it holds for a stranger.
 */
export async function requireRevision(context: AppContext, revisionId: string, access: ResourceAccess) {
  const db = context.get('db')
  const [row] = await db
    .select({ revision: analysisRevisions })
    .from(analysisRevisions)
    .innerJoin(runs, eq(analysisRevisions.runId, runs.id))
    .where(and(eq(analysisRevisions.id, revisionId), isNull(runs.deletedAt)))
    .limit(1)
  if (!row || !reachesResource(context.get('actor'), row.revision.ownerUserId, access)) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return row.revision
}

export interface ResolvedPosterFigure {
  figure: typeof posterFigures.$inferSelect
  revision: typeof analysisRevisions.$inferSelect
}

/**
 * Resolve a poster figure of a live run, together with the revision it draws.
 *
 * Both rows come back because every caller needs both: the retry path re-validates the submitted
 * spec against the revision, and the render path needs the revision's run and owner to build the
 * R2 key and charge the right quota. Resolving them in one statement also means the `deleted_at`
 * filter cannot be applied to one and forgotten on the other.
 */
export async function requirePosterFigure(
  context: AppContext,
  posterId: string,
  access: ResourceAccess,
): Promise<ResolvedPosterFigure> {
  const db = context.get('db')
  const [row] = await db
    .select({ figure: posterFigures, revision: analysisRevisions })
    .from(posterFigures)
    .innerJoin(analysisRevisions, eq(posterFigures.analysisRevisionId, analysisRevisions.id))
    .innerJoin(runs, eq(analysisRevisions.runId, runs.id))
    .where(and(eq(posterFigures.id, posterId), isNull(runs.deletedAt)))
    .limit(1)
  if (!row || !reachesResource(context.get('actor'), row.figure.ownerUserId, access)) {
    throw new ApiError('RESOURCE_NOT_FOUND')
  }
  return row
}
