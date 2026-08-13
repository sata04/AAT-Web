/**
 * The D1 schema, in Drizzle form. `apps/web/migrations/` is generated from this file by
 * drizzle-kit and is what actually runs against the database; this module is the source of truth
 * both for that generation and for every query the Worker makes.
 *
 * Conventions, and why:
 *
 *  - **JavaScript keys are camelCase, SQL columns are snake_case.** Better Auth's Drizzle adapter
 *    resolves a field by indexing the exported table object with the field name from its own model
 *    definition (`schemaModel[fieldName]`), so the JS keys of the auth tables are not free — they
 *    must be `emailVerified`, `expiresAt`, `userId`, and so on. The SQL column names are free, and
 *    snake_case is what reads well in a migration. The app tables follow the same convention so
 *    there is only one rule to remember.
 *
 *  - **Timestamps are `integer({ mode: 'timestamp' })`.** Better Auth hands the adapter real `Date`
 *    objects (its adapter config does not set `supportsDates: false`), and this mode is the one
 *    that round-trips a `Date` through SQLite without a string encoding in the middle.
 *
 *  - **Every id is an opaque ULID.** Sequential integers leak how many users exist and how many
 *    runs a colleague has uploaded, and they make an IDOR probe a matter of counting. That still
 *    matters under the shared-workspace policy: a Viewer reaches only their own rows, and an
 *    anonymous caller reaches none, so an id space that can be walked is an oracle for both. ULIDs
 *    are also lexicographically sortable by creation time, which is why several indexes below can
 *    lean on the id instead of carrying a separate ordering column.
 *
 *  - **No time series.** Not one table stores a sample per row. Full-resolution series live in R2
 *    as snapshot objects; D1 stores the metadata needed to find, authorise and describe them.
 */

import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/* ------------------------------------------------------------------------------------------- */
/* Better Auth core tables                                                                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * Better Auth's user table.
 *
 * `email` is required by Better Auth and is deliberately synthetic here: every user gets
 * `<opaque-user-id>@aat.invalid`, generated server-side (see worker/auth/identity.ts). AAT collects
 * no real email address, never displays this value as identity and never sends mail — `.invalid`
 * is reserved by RFC 2606 precisely so that it can never resolve. The column exists because the
 * framework's model requires it, not because the product has an email concept.
 *
 * `role` is the AAT role (`Admin` / `Researcher` / `Viewer` from @aat/shared), which is also what
 * the Admin plugin reads. Capabilities are derived from it at request time rather than stored, so
 * a change to the capability table takes effect without a data migration.
 */
export const user = sqliteTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    // Admin plugin fields.
    role: text('role').notNull().default('Viewer'),
    banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
    banReason: text('ban_reason'),
    banExpires: integer('ban_expires', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('user_email_unique').on(table.email),
    index('user_role_idx').on(table.role),
    index('user_created_at_idx').on(table.createdAt),
  ],
)

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    token: text('token').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    impersonatedBy: text('impersonated_by'),
  },
  (table) => [
    uniqueIndex('session_token_unique').on(table.token),
    index('session_user_id_idx').on(table.userId),
  ],
)

/**
 * Better Auth's account table.
 *
 * AAT registers no credential providers — no password, no OAuth, no magic link — so in a healthy
 * deployment this table stays empty. It exists because Better Auth's internal adapter reads it on
 * paths that are shared with providers we do not enable, and an absent table would be a runtime
 * error rather than an empty result.
 */
export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('account_user_id_idx').on(table.userId)],
)

/**
 * Better Auth's verification table, used as the store for short-lived single-use values — here,
 * the WebAuthn challenges the passkey plugin issues.
 *
 * It is used rather than a bespoke table because `internalAdapter.consumeVerificationValue()`
 * deletes and returns a row atomically, which is exactly the "exactly one caller may spend this
 * challenge" property a replay-resistant ceremony needs. The plugin names the row from a signed
 * cookie, so a replayed ceremony finds nothing left to consume and is refused without this
 * project having to implement its own compare-and-delete.
 */
export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('verification_identifier_idx').on(table.identifier),
    index('verification_expires_at_idx').on(table.expiresAt),
  ],
)

/**
 * Registered passkeys (WebAuthn credentials).
 *
 * This is the `@better-auth/passkey` plugin's own model, spelled in Drizzle. The plugin writes
 * every row here through Better Auth's adapter, which resolves a field by indexing this exported
 * table object with the field name from the plugin's schema — so `publicKey`, `credentialID`,
 * `deviceType` and `backedUp` are not free-choice names, they are the plugin's. `publicKey` holds
 * the COSE key exactly as the authenticator produced it, base64 encoded by the plugin;
 * `transports` is the comma-joined list the plugin stores, not JSON.
 *
 * `counter` is the authenticator's signature counter. A counter that fails to advance on an
 * authenticator that uses them is the documented clone signal, and `@simplewebauthn/server` checks
 * it on every assertion.
 *
 * Two deliberate departures from the plugin's schema, both additive so the plugin never notices:
 *
 *  - **`credential_id` is UNIQUE**, where the plugin asks only for an index. One credential
 *    belonging to two accounts is not a state this system should be able to reach, and the
 *    registration seam refuses it with a clean error before the constraint ever fires. The index
 *    is the backstop for the case the seam misses.
 *  - **`last_used_at` exists and is nullable.** The plugin does not maintain it; AAT does, from
 *    the authentication seam, because "which of my passkeys is stale?" is the question the
 *    credential-management screen exists to answer. Nullable is what keeps it invisible to the
 *    plugin: the adapter only ever writes fields the plugin's schema declares.
 */
export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull().default(0),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    transports: text('transports'),
    aaguid: text('aaguid'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('passkey_credential_id_unique').on(table.credentialID),
    index('passkey_user_id_idx').on(table.userId),
  ],
)

/* ------------------------------------------------------------------------------------------- */
/* Invitations                                                                                  */
/* ------------------------------------------------------------------------------------------- */

/**
 * Registration and recovery invitations.
 *
 * Only the SHA-256 of the 256-bit token is stored: a database dump, a backup or a leaked query log
 * therefore contains nothing that can be redeemed. The plaintext exists exactly once, in the
 * response to the admin who created it.
 *
 * `status` drives a small state machine that makes concurrent redemption safe without a
 * transaction:
 *
 *   pending --(conditional UPDATE, exactly one winner)--> claimed --> used
 *      ^                                                     |
 *      +--------------- claim expiry sweep ------------------+
 *
 * The claim step is what two concurrent redemptions race for, and it is a single UPDATE whose
 * WHERE clause carries the whole precondition (see worker/auth/invitations.ts). A claim that is
 * never completed — the user closes the tab at the passkey prompt — expires and returns the
 * invitation to `pending`, so an abandoned registration does not permanently burn an invite.
 *
 * `kind` distinguishes onboarding from admin-assisted passkey recovery. A recovery invitation
 * carries `targetUserId` and adds a credential to that existing user instead of creating one.
 */
export const registrationInvites = sqliteTable(
  'registration_invites',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    kind: text('kind').notNull(),
    role: text('role').notNull(),
    /** Display name pre-filled for the invitee; never an email address. */
    displayName: text('display_name').notNull(),
    note: text('note'),
    targetUserId: text('target_user_id').references(() => user.id, { onDelete: 'cascade' }),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    status: text('status').notNull().default('pending'),
    claimContextHash: text('claim_context_hash'),
    claimedAt: integer('claimed_at', { mode: 'timestamp' }),
    claimExpiresAt: integer('claim_expires_at', { mode: 'timestamp' }),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    usedByUserId: text('used_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    revokedByUserId: text('revoked_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    // The lookup on redemption is by token hash, and it must be unique: two invitations that
    // hashed to the same value would both be spendable by one token.
    uniqueIndex('registration_invites_token_hash_unique').on(table.tokenHash),
    index('registration_invites_status_idx').on(table.status, table.expiresAt),
    index('registration_invites_target_user_idx').on(table.targetUserId),
  ],
)

/* ------------------------------------------------------------------------------------------- */
/* Research data                                                                                */
/* ------------------------------------------------------------------------------------------- */

/** A research grouping. A project owns runs; it is not itself an experiment. */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp' }),
  },
  (table) => [index('projects_owner_idx').on(table.ownerUserId, table.createdAt)],
)

/**
 * One physical experiment — one drop of the capsule.
 *
 * `runCode` is the identity the researchers actually use ("260811a": the date plus the
 * within-day suffix), parsed from the source filename by @aat/shared's `parseRunFilename`. Two
 * drops on the same day are two runs, never two versions of one run, which is why the suffix is
 * part of the code and the uniqueness constraint.
 *
 * Uniqueness is per owner: two researchers each having a run 260811a is normal, and a global
 * unique constraint would make one of them unable to record their own experiment.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runCode: text('run_code').notNull(),
    /** ISO `yyyy-mm-dd`, or null when the filename did not follow the run-code convention. */
    experimentDate: text('experiment_date'),
    /** '' when the run has no within-day suffix. */
    suffix: text('suffix'),
    originalFilename: text('original_filename').notNull(),
    memo: text('memo'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('runs_owner_run_code_unique').on(table.ownerUserId, table.runCode),
    // The gallery's default ordering: a user's runs, newest experiment first.
    index('runs_owner_experiment_date_idx').on(table.ownerUserId, table.experimentDate),
    index('runs_owner_created_at_idx').on(table.ownerUserId, table.createdAt),
    index('runs_project_idx').on(table.projectId),
  ],
)

/**
 * Free-form tags on a run. A join table rather than a JSON column because the gallery filters by
 * tag, and filtering by tag over a JSON blob means a full scan.
 */
export const runTags = sqliteTable(
  'run_tags',
  {
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    tag: text('tag').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.tag] }), index('run_tags_tag_idx').on(table.tag)],
)

/**
 * ONE IMMUTABLE ANALYSIS of a run.
 *
 * A revision is created, never updated. It records which bytes were analysed (`sourceSha256`),
 * with which settings (`configHash` plus the full config for provenance) and by which engine
 * (`engineVersion`). Re-analysing the same source with the same config and engine is not a new
 * revision — it is the same revision, which is what `revisions_run_identity_unique` enforces.
 *
 * A repeated *physical* run is a new `runs` row, not a revision: the capsule was dropped twice, so
 * there are two experiments. Conflating the two would make "revision 3" mean either "the third
 * time we analysed this data" or "the third time we ran this experiment" depending on who is
 * reading, and the second reading silently destroys history.
 */
export const analysisRevisions = sqliteTable(
  'analysis_revisions',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 1-based, per run, in creation order. Human-facing; the id remains the durable handle. */
    revisionNumber: integer('revision_number').notNull(),
    sourceSha256: text('source_sha256').notNull(),
    configHash: text('config_hash').notNull(),
    /** The full analysis configuration as canonical JSON, so a revision explains itself. */
    configJson: text('config_json').notNull(),
    engineVersion: text('engine_version').notNull(),
    appVersion: text('app_version').notNull(),
    snapshotFormatVersion: integer('snapshot_format_version').notNull(),
    /** The R2 object holding the full-resolution snapshot; null until the upload finalises. */
    snapshotObjectId: text('snapshot_object_id'),
    notes: text('notes'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('revisions_run_revision_number_unique').on(table.runId, table.revisionNumber),
    // "Same bytes, same settings, same engine" is one analysis. The database says so, so a
    // double-submit or two tabs cannot produce two revisions that are identical but for their id.
    uniqueIndex('revisions_run_identity_unique').on(
      table.runId,
      table.sourceSha256,
      table.configHash,
      table.engineVersion,
    ),
    index('revisions_run_created_idx').on(table.runId, table.createdAt),
    index('revisions_owner_created_idx').on(table.ownerUserId, table.createdAt),
  ],
)

/**
 * The headline numbers of a revision, denormalised out of the snapshot so the gallery can show
 * "best 0.1 s window: 1.2e-4 G" without fetching a multi-megabyte object from R2.
 *
 * The G-quality sweep is a JSON column: it is ~19 rows for the default 0.1–1.0 s range, it is
 * always read whole, and it is never filtered on. That is a document, not a table.
 */
export const analysisMetrics = sqliteTable(
  'analysis_metrics',
  {
    id: text('id').primaryKey(),
    analysisRevisionId: text('analysis_revision_id')
      .notNull()
      .references(() => analysisRevisions.id, { onDelete: 'cascade' }),
    /** Encoded with @aat/shared's scalar tagging, so NaN / ±Infinity / -0 survive JSON. */
    innerMean: text('inner_mean'),
    innerStd: text('inner_std'),
    innerStartTime: text('inner_start_time'),
    dragMean: text('drag_mean'),
    dragStd: text('drag_std'),
    dragStartTime: text('drag_start_time'),
    windowSize: text('window_size').notNull(),
    innerSampleCount: integer('inner_sample_count').notNull(),
    dragSampleCount: integer('drag_sample_count').notNull(),
    warningCount: integer('warning_count').notNull().default(0),
    gQualityJson: text('g_quality_json'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [uniqueIndex('metrics_revision_unique').on(table.analysisRevisionId)],
)

/* ------------------------------------------------------------------------------------------- */
/* Posters                                                                                      */
/* ------------------------------------------------------------------------------------------- */

/**
 * The frozen poster presets. A preset is content-addressed by `specHash` and versioned by
 * `presetVersion`; both are recorded on every figure so a figure can always be explained by the
 * preset that produced it, even after the preset has moved on.
 */
export const posterPresets = sqliteTable(
  'poster_presets',
  {
    id: text('id').primaryKey(),
    presetKey: text('preset_key').notNull(),
    presetVersion: text('preset_version').notNull(),
    specHash: text('spec_hash').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    description: text('description'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [uniqueIndex('poster_presets_key_version_unique').on(table.presetKey, table.presetVersion)],
)

/**
 * A rendered poster figure.
 *
 * `poster_figures_auto_unique` is a PARTIAL unique index on
 * `(analysis_revision_id, preset_version) WHERE kind = 'auto'`. That is the whole idempotency
 * guarantee for automatic posters, and it lives in the database on purpose: a client-side "have we
 * already rendered this?" check loses to a double-submit, to a reload in the middle of the
 * request, and to the same user on two devices. Custom posters are excluded from the constraint —
 * a researcher may render as many hand-configured variants of a revision as they like.
 */
export const posterFigures = sqliteTable(
  'poster_figures',
  {
    id: text('id').primaryKey(),
    analysisRevisionId: text('analysis_revision_id')
      .notNull()
      .references(() => analysisRevisions.id, { onDelete: 'cascade' }),
    /**
     * The owner of the revision this figure draws — not the member who asked for the render. A
     * figure belongs to the measurement, so that the auto-poster uniqueness constraint means the
     * same thing whoever triggered it and so the PNG is reclaimed with the run. Who rendered it is
     * recorded in `audit_logs`, which is where an actor belongs.
     */
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'auto' — the one automatic figure per revision — or 'custom'. */
    kind: text('kind').notNull(),
    presetKey: text('preset_key').notNull(),
    presetVersion: text('preset_version').notNull(),
    /** SHA-256 of the canonical plot spec that was sent to the renderer. */
    specHash: text('spec_hash').notNull(),
    rendererVersion: text('renderer_version'),
    /**
     * 'queued' | 'rendering' | 'ready' | 'failed' — the vocabulary in `@aat/plot-spec`'s
     * `PosterFigureStatusSchema`, which is what `services/poster.ts` writes and what the client
     * parses. One vocabulary spans browser, Worker and database on purpose.
     */
    status: text('status').notNull(),
    objectId: text('object_id'),
    errorCode: text('error_code'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    startedAt: integer('started_at', { mode: 'timestamp' }),
    completedAt: integer('completed_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('poster_figures_auto_unique')
      .on(table.analysisRevisionId, table.presetVersion)
      .where(sql`kind = 'auto'`),
    index('poster_figures_revision_idx').on(table.analysisRevisionId, table.createdAt),
    index('poster_figures_status_idx').on(table.status, table.startedAt),
    index('poster_figures_owner_idx').on(table.ownerUserId, table.createdAt),
  ],
)

/* ------------------------------------------------------------------------------------------- */
/* Storage, quotas, audit                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * The index of everything in R2. Nothing is written to the bucket without a row here first, and
 * nothing is read from the bucket without this row naming who owns it and the resolver in
 * worker/middleware/authorize.ts deciding whether the caller reaches that owner.
 *
 * `ownerUserId` is the owner of the *run* the object belongs to, never the user who happened to
 * create it. A poster a colleague rendered from your revision is stored, keyed, quota-charged and
 * reclaimed as yours, because deleting the run has to reclaim every byte it caused — and it cannot
 * do that coherently if the objects inside one run are charged to several accounts.
 *
 * `originalFilename` is metadata and *only* metadata: it is never a component of `r2Key`. An
 * attacker-supplied filename in an object key is a path-traversal and key-collision primitive, and
 * "the user picked this name" is exactly the wrong reason to trust a string.
 */
export const cloudObjects = sqliteTable(
  'cloud_objects',
  {
    id: text('id').primaryKey(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'snapshot' | 'poster' | 'source'. */
    kind: text('kind').notNull(),
    r2Key: text('r2_key').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    contentType: text('content_type').notNull(),
    originalFilename: text('original_filename'),
    runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    analysisRevisionId: text('analysis_revision_id').references(() => analysisRevisions.id, {
      onDelete: 'cascade',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  },
  (table) => [
    uniqueIndex('cloud_objects_r2_key_unique').on(table.r2Key),
    index('cloud_objects_owner_kind_idx').on(table.ownerUserId, table.kind),
    index('cloud_objects_run_idx').on(table.runId),
  ],
)

/**
 * Per-user storage accounting.
 *
 * "Per-user" means per *owner of the run*, not per uploader: an object is charged to whoever the
 * run belongs to, so that deleting a run gives its bytes back to exactly the account they were
 * taken from. See worker/services/quota.ts.
 *
 * `bytesReserved` is the in-flight column that makes the quota race-safe: an upload reserves
 * before it writes, so two simultaneous uploads that would each fit individually cannot both
 * succeed past the limit. The reservation is converted to `bytesUsed` only once the bytes are on
 * disk and have been measured, never from anything the client claimed.
 */
export const quotaUsage = sqliteTable('quota_usage', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  bytesUsed: integer('bytes_used').notNull().default(0),
  bytesReserved: integer('bytes_reserved').notNull().default(0),
  bytesLimit: integer('bytes_limit').notNull(),
  objectCount: integer('object_count').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

/**
 * An in-flight upload's claim on quota. Rows are short-lived: finalised, released, or reclaimed by
 * the sweeper once `expiresAt` passes (which is what covers a client that vanishes mid-upload).
 */
export const quotaReservations = sqliteTable(
  'quota_reservations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    bytes: integer('bytes').notNull(),
    /** 'snapshot' | 'poster' | 'source'. */
    purpose: text('purpose').notNull(),
    /** The R2 key this reservation is for, so the sweeper can delete an orphaned object. */
    r2Key: text('r2_key'),
    /** 'pending' | 'finalised' | 'released'. */
    status: text('status').notNull().default('pending'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('quota_reservations_status_idx').on(table.status, table.expiresAt)],
)

/**
 * Append-only record of security-relevant actions.
 *
 * `details` is JSON and is written by code that must never put a credential in it: invitation rows
 * are logged by id, never by token or token hash (see worker/services/audit.ts, which strips them).
 *
 * `targetOwnerUserId` is the member whose work was acted on, which since the workspace policy of
 * 2026-08-13 is frequently *not* the actor: a researcher may read, and an administrator may delete,
 * a colleague's run. "Who touched my measurements?" is the question that policy created, and it
 * cannot be answered by filtering on `actorUserId`. It is a column rather than a key in `details`
 * because it is indexed and queried, not merely displayed.
 */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorUserId: text('actor_user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** The owner of the thing acted on. Null when the action has no owned target. */
    targetOwnerUserId: text('target_owner_user_id').references(() => user.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    details: text('details'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('audit_logs_created_at_idx').on(table.createdAt),
    index('audit_logs_actor_idx').on(table.actorUserId, table.createdAt),
    index('audit_logs_action_idx').on(table.action, table.createdAt),
    // "Everything anyone did to this member's data", which is the cross-user question.
    index('audit_logs_target_owner_idx').on(table.targetOwnerUserId, table.createdAt),
  ],
)

/**
 * Small key/value store for operational switches that must survive a restart and be changeable
 * without a deploy — currently the poster renderer's circuit breaker.
 */
export const systemFlags = sqliteTable('system_flags', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  updatedByUserId: text('updated_by_user_id').references(() => user.id, { onDelete: 'set null' }),
})

/**
 * Fixed-window rate-limit counters.
 *
 * D1 rather than the Rate Limiting binding: the limits that matter here (invitation redemption,
 * poster generation) must be enforced *exactly* and must be observable in tests, and a binding
 * whose state cannot be inspected or reset from a test is not something to hang invitation
 * security on.
 */
export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  windowStart: integer('window_start').notNull(),
})
