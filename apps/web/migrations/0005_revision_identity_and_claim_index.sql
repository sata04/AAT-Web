-- Make the column mapping part of a revision's analysis identity.
--
-- Before this, "the same analysis" meant (run, source bytes, config hash, engine version) — the
-- mapping from CSV columns to the Inner Capsule / Drag Shield sensors was not part of it. That
-- hid a real mis-recording: re-analysing a file with a *different* column choice answered
-- `created: false` for the existing revision, and the client — correctly believing a stored
-- revision is immutable — skipped its snapshot upload. The record then claimed one column
-- mapping while describing another run of analysis: the snapshot and metrics stored under it
-- belonged to the first mapping ever synced, which is exactly the kind of quietly wrong record
-- this tool exists to prevent.
--
-- The mapping goes into the identity as a hash rather than as the three columns' text: the index
-- needs a fixed-width value, and the human-readable mapping is already on record inside each
-- snapshot's `detected_columns`.
--
-- `mapping_hash` is nullable so existing rows can stay: they were recorded without a mapping, and
-- SQLite treats NULLs as distinct under a unique index, so an old row can never be mistaken for a
-- new request's identity. The consequence is deliberate — re-syncing a pre-migration analysis
-- mints one extra revision rather than risk reusing a row whose mapping is not on record.
--
-- Safe as a column add plus an index swap: no table rebuild, no UPDATE over existing rows, and
-- the new index's key is strictly more specific than the old one's, so it cannot fail on data
-- that satisfied the old index.
--
-- Also included: an index on `registration_invites.claim_context_hash`, the column
-- `resolveRegistrationContext` searches on every registration ceremony.
DROP INDEX `revisions_run_identity_unique`;--> statement-breakpoint
ALTER TABLE `analysis_revisions` ADD `mapping_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_run_identity_unique` ON `analysis_revisions` (`run_id`,`source_sha256`,`config_hash`,`engine_version`,`mapping_hash`);--> statement-breakpoint
CREATE INDEX `registration_invites_claim_context_idx` ON `registration_invites` (`claim_context_hash`);