/**
 * Runs.
 *
 * A run is one physical experiment — one drop of the capsule — identified by its run code
 * ("260811a": the date plus a within-day suffix). Creating a run records that the experiment
 * happened; it does not upload anything. Analyses of it are immutable revisions (see
 * ./revisions.ts), and repeating the experiment creates a *new run*, never a new revision.
 *
 * Deletion is soft (`deleted_at`) for the metadata but hard for the bytes: the R2 objects are
 * removed and the owner's quota is corrected in the same request. A "deleted" run that still costs
 * storage is a bill nobody can explain.
 *
 * Who may reach whose run is decided in one place — `requireRun(context, id, level)` — and the
 * level is named at every call site below. Reading and annotating are open to the team; deleting is
 * not. See worker/middleware/authorize.ts for the policy and the reasoning behind it.
 *
 * **A run is grouped by its tags and by nothing else.** This file used to serve `/projects` as well,
 * and a run carried a `project_id`; migration 0003 removed both. The short version is that projects
 * never became usable — no client could create one and no screen could file a run into one — and
 * that when the deployment became a shared workspace, tags followed the policy and projects did not:
 * `GET /projects` answered with the caller's own while `PATCH /runs/:runId` demanded a project
 * belonging to the run's owner, which made the field unusable on exactly the colleague's run the
 * policy exists to let a researcher annotate. Tags express the same grouping, already shared,
 * already filterable in both listings, already editable. See worker/db/schema.ts.
 */

import { ApiError, parseRunFilename } from '@aat/shared'
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte, or, type SQL, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { rowsAffected } from '../db/client.ts'
import { analysisRevisions, cloudObjects, posterFigures, runs, runTags, user } from '../db/schema.ts'
import { newId } from '../lib/ids.ts'
import type { AppEnv } from '../middleware/authorize.ts'
import { requireCapability, requireRun, requireSession, withDatabase } from '../middleware/authorize.ts'
import { validate } from '../middleware/validate.ts'
import { writeAuditLog } from '../services/audit.ts'
import { releaseUsage } from '../services/quota.ts'

export const runRoutes = new Hono<AppEnv>()

runRoutes.use('*', withDatabase, requireSession)

const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE = 100

const tagSchema = z
  .string()
  .min(1)
  .max(64)
  // Tags are displayed verbatim in the gallery; control characters in one are either a mistake or
  // an attempt to break a renderer.
  // Checked by code point rather than by regex: a character class spanning the
  // control range has to contain control characters, which is exactly what a
  // linter should flag, and this reads more clearly anyway.
  .refine(
    (value) =>
      ![...value].some((char) => {
        const code = char.codePointAt(0) ?? 0
        return code < 0x20 || code === 0x7f
      }),
    'Tags cannot contain control characters',
  )

const createRunSchema = z.object({
  /** Optional: derived from `originalFilename` when the filename follows the run-code convention. */
  runCode: z
    .string()
    .regex(/^\d{6}[a-z]?$/)
    .optional(),
  originalFilename: z.string().min(1).max(255),
  experimentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  memo: z.string().max(4000).optional(),
  tags: z.array(tagSchema).max(32).optional(),
})

const updateRunSchema = z.object({
  memo: z.string().max(4000).nullable().optional(),
  tags: z.array(tagSchema).max(32).optional(),
})

const listQuerySchema = z.object({
  /** Substring match against the run code and the original filename. */
  search: z.string().max(128).optional(),
  tag: tagSchema.optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  /** Opaque: the id of the last row of the previous page. */
  cursor: z.string().min(1).max(64).optional(),
})

/**
 * The filters both listings share, minus the scope.
 *
 * Extracted so that `GET /runs` and `GET /workspace/runs` cannot drift: a search that escapes
 * `%` in one listing and not the other, or a `deleted_at` filter present in one and forgotten in
 * the other, is exactly the divergence two hand-maintained copies of this block would produce.
 * The *scope* is the one thing each caller supplies for itself, because that is the only part the
 * two endpoints genuinely disagree about.
 */
function runListFilters(query: z.infer<typeof listQuerySchema>): SQL[] {
  const conditions: SQL[] = [isNull(runs.deletedAt)]
  if (query.from) conditions.push(gte(runs.experimentDate, query.from))
  if (query.to) conditions.push(lte(runs.experimentDate, query.to))
  if (query.search) {
    const pattern = `%${query.search.replace(/[%_\\]/g, (character) => `\\${character}`)}%`
    const searchCondition = or(
      like(runs.runCode, sql`${pattern} ESCAPE '\\'`),
      like(runs.originalFilename, sql`${pattern} ESCAPE '\\'`),
    )
    if (searchCondition) conditions.push(searchCondition)
  }
  if (query.tag) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM ${runTags} WHERE ${runTags.runId} = ${runs.id} AND ${runTags.tag} = ${query.tag})`,
    )
  }
  // Keyset pagination on the ULID primary key: ULIDs sort by creation time, so "everything after
  // this id" is a stable page boundary even while new runs are being created. An OFFSET would
  // silently skip or repeat rows when that happens. It holds across owners too — a ULID is unique
  // deployment-wide — which is what lets the team listing page the same way.
  if (query.cursor) conditions.push(lt(runs.id, query.cursor))
  return conditions
}

async function loadTags(
  db: AppEnv['Variables']['db'],
  runIds: readonly string[],
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>()
  if (runIds.length === 0) return grouped
  const rows = await db
    .select()
    .from(runTags)
    .where(inArray(runTags.runId, [...runIds]))
  for (const row of rows) {
    const list = grouped.get(row.runId)
    if (list) list.push(row.tag)
    else grouped.set(row.runId, [row.tag])
  }
  return grouped
}

/**
 * List the caller's own runs.
 *
 * This stays owner-scoped even under the shared-workspace policy, and the scoping is in the WHERE
 * clause rather than in a filter the client can drop. A team-wide gallery is a different endpoint
 * with different needs — it has to show whose run each row is, page across owners, and let a
 * researcher choose whose work they are looking at — and quietly folding every colleague's runs
 * into "my runs" would make the one listing a researcher relies on stop meaning anything. Reaching
 * a colleague's run by id is what the policy widened; enumerating theirs here is not.
 */
runRoutes.get(
  '/',
  requireCapability('analysis:read'),
  validate('query', listQuerySchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const query = context.req.valid('query')
    const limit = query.limit ?? DEFAULT_PAGE_SIZE

    // The scope is in the WHERE clause, not a filter the client can drop.
    const conditions = [eq(runs.ownerUserId, actor.userId), ...runListFilters(query)]

    const rows = await db
      .select()
      .from(runs)
      .where(and(...conditions))
      .orderBy(desc(runs.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    const tags = await loadTags(
      db,
      page.map((row) => row.id),
    )

    return context.json({
      runs: page.map((row) => ({
        id: row.id,
        runCode: row.runCode,
        experimentDate: row.experimentDate,
        suffix: row.suffix,
        originalFilename: row.originalFilename,
        memo: row.memo,
        tags: tags.get(row.id) ?? [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    })
  },
)

runRoutes.post(
  '/',
  requireCapability('analysis:create'),
  validate('json', createRunSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const body = context.req.valid('json')
    const now = new Date()

    // The filename is the authority on run identity when it follows the convention, because that is
    // where the researchers encode it. An explicit runCode overrides it for the files that do not.
    const parsed = parseRunFilename(body.originalFilename)
    const runCode = body.runCode ?? parsed.runCode
    if (!runCode) {
      throw new ApiError('INVALID_ANALYSIS_CONFIG', {
        details: { reason: 'run_code_required', originalFilename: body.originalFilename },
      })
    }
    const experimentDate = body.experimentDate ?? parsed.experimentDate
    const suffix = parsed.runCode === runCode ? parsed.suffix : (runCode.match(/[a-z]$/)?.[0] ?? '')

    const id = newId()
    try {
      await db.insert(runs).values({
        id,
        ownerUserId: actor.userId,
        runCode,
        experimentDate: experimentDate ?? null,
        suffix: suffix ?? '',
        originalFilename: body.originalFilename,
        memo: body.memo ?? null,
        createdAt: now,
        updatedAt: now,
      })
    } catch (error) {
      // runs_owner_run_code_unique: this owner already has this run. Two drops on one day are two
      // run codes (260811a, 260811b), so a collision means the same experiment is being created
      // twice, not that the suffix convention needs relaxing.
      //
      // `deleted_at IS NULL` matches the index's own predicate (migration 0004), and the agreement
      // is load-bearing rather than tidy: this lookup explains a constraint violation, so a row the
      // constraint no longer covers is not an explanation for it. Without the filter this reported
      // a *tombstoned* run as the conflict and handed back its id, which `sync.ts` then attached a
      // revision to — and `requireRun` answered 404 for it. Reporting a run the caller cannot
      // reach is worse than reporting nothing.
      const [existing] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.ownerUserId, actor.userId), eq(runs.runCode, runCode), isNull(runs.deletedAt)))
        .limit(1)
      if (existing) {
        throw new ApiError('INVALID_ANALYSIS_CONFIG', {
          details: { reason: 'run_code_already_exists', runCode, runId: existing.id },
        })
      }
      throw error
    }

    if (body.tags?.length) {
      await db
        .insert(runTags)
        .values(body.tags.map((tag) => ({ runId: id, tag, createdAt: now })))
        .onConflictDoNothing()
    }

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'run.create',
      targetType: 'run',
      targetId: id,
      // A run is always created by its owner; recorded anyway so that every run entry in the log
      // carries an owner and the cross-user ones are found by filtering rather than by absence.
      targetOwnerUserId: actor.userId,
      details: { runCode },
      headers: context.req.raw.headers,
    })

    return context.json({ run: { id, runCode, experimentDate: experimentDate ?? null } }, 201)
  },
)

runRoutes.get('/:runId', requireCapability('analysis:read'), async (context) => {
  const db = context.get('db')
  const run = await requireRun(context, context.req.param('runId'), 'read')
  const tags = await loadTags(db, [run.id])
  const revisions = await db
    .select({
      id: analysisRevisions.id,
      revisionNumber: analysisRevisions.revisionNumber,
      configHash: analysisRevisions.configHash,
      engineVersion: analysisRevisions.engineVersion,
      createdAt: analysisRevisions.createdAt,
    })
    .from(analysisRevisions)
    .where(eq(analysisRevisions.runId, run.id))
    .orderBy(asc(analysisRevisions.revisionNumber))

  return context.json({
    run: {
      id: run.id,
      // Who the run belongs to, so a client can tell a colleague's measurement from its own and
      // not offer a delete button that is going to answer 404. Under the shared-workspace policy
      // this endpoint answers for runs the caller does not own, and a response that did not say so
      // would make every one of them look like the reader's own work.
      ownerUserId: run.ownerUserId,
      runCode: run.runCode,
      experimentDate: run.experimentDate,
      suffix: run.suffix,
      originalFilename: run.originalFilename,
      memo: run.memo,
      tags: tags.get(run.id) ?? [],
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    },
    revisions: revisions.map((revision) => ({
      id: revision.id,
      revisionNumber: revision.revisionNumber,
      configHash: revision.configHash,
      engineVersion: revision.engineVersion,
      createdAt: revision.createdAt.toISOString(),
    })),
  })
})

runRoutes.patch(
  '/:runId',
  requireCapability('analysis:update'),
  validate('json', updateRunSchema),
  async (context) => {
    const db = context.get('db')
    const actor = context.get('actor')
    const run = await requireRun(context, context.req.param('runId'), 'annotate')
    const body = context.req.valid('json')
    const now = new Date()

    // Everything annotatable here is a label on the run: the memo and the tags. Both mean the same
    // thing whoever wrote them, which is what makes `annotate` the right level for a colleague — a
    // field that instead *moved* the run into a grouping only the editor could see would not be an
    // annotation at all, and that is precisely why the project field could not be made to work
    // under the shared-workspace policy. See the module doc.
    const patch: Record<string, unknown> = { updatedAt: now }
    if (body.memo !== undefined) patch.memo = body.memo
    await db.update(runs).set(patch).where(eq(runs.id, run.id))

    if (body.tags) {
      // Replace wholesale: the client sends the set it wants, not a diff, so there is no
      // ordering question between an add and a remove that arrive together.
      await db.delete(runTags).where(eq(runTags.runId, run.id))
      if (body.tags.length > 0) {
        await db
          .insert(runTags)
          .values(body.tags.map((tag) => ({ runId: run.id, tag, createdAt: now })))
          .onConflictDoNothing()
      }
    }

    await writeAuditLog(db, {
      actorUserId: actor.userId,
      action: 'run.update',
      targetType: 'run',
      targetId: run.id,
      targetOwnerUserId: run.ownerUserId,
      headers: context.req.raw.headers,
    })

    return context.json({ ok: true })
  },
)

runRoutes.delete('/:runId', requireCapability('analysis:delete'), async (context) => {
  const db = context.get('db')
  const actor = context.get('actor')
  // `destroy`, which no Researcher holds for another member's run: deleting a colleague's
  // experiment removes bytes nobody can recompute, and it is the one action in this file that is
  // not reversible by re-running the request differently.
  const run = await requireRun(context, context.req.param('runId'), 'destroy')
  const now = new Date()

  // Delete the bytes first and correct the quota as each object goes, so a failure partway through
  // leaves the account charged for objects that still exist rather than for objects that do not.
  const objects = await db
    .select()
    .from(cloudObjects)
    .where(and(eq(cloudObjects.runId, run.id), isNull(cloudObjects.deletedAt)))

  /*
   * The quota release is gated on winning the tombstone, not on having read the row.
   *
   * `requireRun` and this loop are several statements apart, so two concurrent deletes of the same
   * run can both pass the ownership check and both walk the same object list. An unconditional
   * decrement would then release the same bytes twice, drifting the account's usage below what it
   * actually stores — and quota is enforced against that number, so the drift is free storage.
   *
   * `AND deleted_at IS NULL` in the UPDATE makes the tombstone the claim: exactly one caller sees
   * a row affected, and only that caller releases. This is the same shape as every other race in
   * this codebase — the invitation claim, the quota reservation, the poster render claim — a
   * conditional UPDATE whose WHERE clause carries the entire precondition.
   *
   * The R2 delete stays unconditional and outside the claim, because it is idempotent and because
   * deleting bytes twice is harmless where releasing them twice is not.
   */
  for (const object of objects) {
    await context.env.AAT_OBJECTS.delete(object.r2Key)
    const claimed = await db
      .update(cloudObjects)
      .set({ deletedAt: now })
      .where(and(eq(cloudObjects.id, object.id), isNull(cloudObjects.deletedAt)))
    if (rowsAffected(claimed) === 1) {
      await releaseUsage(db, object.ownerUserId, object.byteSize, now)
    }
  }

  const revisionIds = await db
    .select({ id: analysisRevisions.id })
    .from(analysisRevisions)
    .where(eq(analysisRevisions.runId, run.id))
  if (revisionIds.length > 0) {
    await db.delete(posterFigures).where(
      inArray(
        posterFigures.analysisRevisionId,
        revisionIds.map((row) => row.id),
      ),
    )
  }

  await db.update(runs).set({ deletedAt: now, updatedAt: now }).where(eq(runs.id, run.id))

  await writeAuditLog(db, {
    actorUserId: actor.userId,
    action: 'run.delete',
    targetType: 'run',
    targetId: run.id,
    targetOwnerUserId: run.ownerUserId,
    details: { objectsDeleted: objects.length },
    headers: context.req.raw.headers,
  })

  return context.json({ ok: true, objectsDeleted: objects.length })
})

/* ------------------------------------------------------------------------------------------- */
/* The team gallery                                                                             */
/* ------------------------------------------------------------------------------------------- */

/**
 * The shared workspace: every member's runs, in one listing.
 *
 * The policy of 2026-08-13 let any member *reach* a colleague's run. This is what makes that
 * reachable in practice — a read you can only exercise if you already know a ULID is a permission
 * nobody can use, and "see the analysed files regardless of author" means being able to find them.
 *
 * ## Why a separate route rather than `GET /runs?scope=team`
 *
 * Because the authorization differs, and this codebase puts authorization in middleware where the
 * route table can be read. A `scope` parameter would make the capability a request-time branch
 * inside the handler: a reader of `index.ts` could no longer tell what `GET /runs` requires, and
 * the Viewer case would have to be answered by silently narrowing the result — which is worse than
 * refusing, because a Viewer handed a short list has no way to know they were not shown the team's.
 * Here the refusal is the ordinary one, `FORBIDDEN` naming `workspace:read`, and it is identical
 * whether or not any colleague's run exists. `GET /runs` keeps meaning exactly "mine".
 *
 * Both capabilities are named on purpose: `analysis:read` is "may look at analyses at all" and
 * `workspace:read` is "may look at *other members'*". A Viewer holds the first and not the second.
 */
export const workspaceRoutes = new Hono<AppEnv>()

workspaceRoutes.use('*', withDatabase, requireSession)

const workspaceListQuerySchema = listQuerySchema.extend({
  /** Narrow to one member's runs — "show me what 田中 has been dropping". */
  ownerUserId: z.string().min(1).max(64).optional(),
})

workspaceRoutes.get(
  '/runs',
  requireCapability('analysis:read'),
  requireCapability('workspace:read'),
  validate('query', workspaceListQuerySchema),
  async (context) => {
    const db = context.get('db')
    const query = context.req.valid('query')
    const limit = query.limit ?? DEFAULT_PAGE_SIZE

    // No owner condition: the scope IS the deployment. Everything else — including the
    // `deleted_at` filter, which a soft-deleted run must not escape through the gallery any more
    // than through its own id — comes from the same builder the caller's own listing uses.
    const conditions = runListFilters(query)
    if (query.ownerUserId) conditions.push(eq(runs.ownerUserId, query.ownerUserId))

    const rows = await db
      .select({ run: runs, ownerDisplayName: user.name })
      .from(runs)
      .innerJoin(user, eq(user.id, runs.ownerUserId))
      .where(and(...conditions))
      .orderBy(desc(runs.id))
      .limit(limit + 1)

    const page = rows.slice(0, limit)
    const tags = await loadTags(
      db,
      page.map((row) => row.run.id),
    )

    return context.json({
      runs: page.map(({ run, ownerDisplayName }) => ({
        id: run.id,
        // Whose run this is, by id and by the name a person recognises. A gallery that cannot say
        // "田中's 260811a" is a list of somebody's runs with the somebody left out — and the
        // display name is the only identity AAT has, since there is no email (see auth/identity.ts).
        ownerUserId: run.ownerUserId,
        ownerDisplayName,
        runCode: run.runCode,
        experimentDate: run.experimentDate,
        suffix: run.suffix,
        originalFilename: run.originalFilename,
        memo: run.memo,
        tags: tags.get(run.id) ?? [],
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      })),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.run.id ?? null) : null,
    })
  },
)
