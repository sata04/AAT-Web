-- Remove the `projects` entity: the table, and the `runs.project_id` column that pointed at it.
--
-- HAND-CORRECTED AFTER GENERATION, and much more heavily than 0002 was. What drizzle-kit emitted
-- for this diff would have destroyed the entire research record on D1. The generated form and the
-- reason it is wrong are worth stating in full, because the failure is silent and the test suite
-- cannot catch it.
--
-- `runs.project_id` cannot be removed with `ALTER TABLE ... DROP COLUMN`: SQLite refuses to drop a
-- column that is named in a foreign key definition ("error in table runs after drop column: unknown
-- column project_id in foreign key definition"), and it is named in one. Dropping the `projects`
-- table alone is not an option either — it leaves the child key pointing at nothing, and the very
-- next `INSERT INTO runs` fails with "no such table: main.projects", so run creation would break
-- for every user. The column and its parent have to go together, which means rebuilding `runs`
-- through SQLite's twelve-step table-alteration procedure.
--
-- Step one of that procedure is `PRAGMA foreign_keys=OFF`, which is what drizzle-kit emitted. **D1
-- does not support it.** D1's enforcement is permanently equivalent to `PRAGMA foreign_keys=on`
-- and every statement runs inside an implicit transaction, so a migration cannot turn it off; the
-- only pragma D1 offers is `defer_foreign_keys`, which defers *violation checking* and does not
-- suppress *referential actions*. That distinction is the whole problem here. With foreign keys
-- enforced, `DROP TABLE runs` performs an implicit DELETE of every row first, and that fires
-- ON DELETE CASCADE into:
--
--     analysis_revisions  -> analysis_metrics, cloud_objects, poster_figures
--     cloud_objects
--     run_tags
--
-- which is every analysis ever recorded, every headline metric, every poster row, and — worst —
-- `cloud_objects`, the only index of what this deployment has stored in R2. Losing it would strand
-- every snapshot and poster PNG in the bucket with nothing pointing at them, still billed, with no
-- way to find them again. Deferring the constraints does not help: the cascade is an action, not a
-- violation, and it still fires.
--
-- So the child rows are carried across by hand. `CREATE TABLE ... AS SELECT` produces a plain table
-- with no foreign keys of its own, which is exactly why the copies survive the cascade that empties
-- the originals. They are restored parent-first and dropped again at the end. `SELECT *` on both
-- sides of the round trip keeps the column order identical, so the restore cannot silently shift a
-- column.
--
-- On an empty database — which is how the workerd suite applies these migrations — every copy and
-- restore below is a no-op, and a wrong version of this file would pass the suite exactly as this
-- one does. What proves it on real data is `test/ui/migrations.test.ts`, which seeds all five
-- tables against the committed 0000-0002 DDL, applies this file with foreign keys enforced the way
-- D1 enforces them, and asserts that not one row was lost.
--
-- Why the entity is going rather than being finished is in docs/cloud-data-model.md; the short
-- version is that runs are grouped by their tags, which are already shared across the workspace.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__keep_run_tags` AS SELECT * FROM `run_tags`;--> statement-breakpoint
CREATE TABLE `__keep_analysis_revisions` AS SELECT * FROM `analysis_revisions`;--> statement-breakpoint
CREATE TABLE `__keep_analysis_metrics` AS SELECT * FROM `analysis_metrics`;--> statement-breakpoint
CREATE TABLE `__keep_cloud_objects` AS SELECT * FROM `cloud_objects`;--> statement-breakpoint
CREATE TABLE `__keep_poster_figures` AS SELECT * FROM `poster_figures`;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`run_code` text NOT NULL,
	`experiment_date` text,
	`suffix` text,
	`original_filename` text NOT NULL,
	`memo` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "owner_user_id", "run_code", "experiment_date", "suffix", "original_filename", "memo", "created_at", "updated_at", "deleted_at") SELECT "id", "owner_user_id", "run_code", "experiment_date", "suffix", "original_filename", "memo", "created_at", "updated_at", "deleted_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_owner_run_code_unique` ON `runs` (`owner_user_id`,`run_code`);--> statement-breakpoint
CREATE INDEX `runs_owner_experiment_date_idx` ON `runs` (`owner_user_id`,`experiment_date`);--> statement-breakpoint
CREATE INDEX `runs_owner_created_at_idx` ON `runs` (`owner_user_id`,`created_at`);--> statement-breakpoint
INSERT INTO `run_tags` SELECT * FROM `__keep_run_tags`;--> statement-breakpoint
INSERT INTO `analysis_revisions` SELECT * FROM `__keep_analysis_revisions`;--> statement-breakpoint
INSERT INTO `analysis_metrics` SELECT * FROM `__keep_analysis_metrics`;--> statement-breakpoint
INSERT INTO `cloud_objects` SELECT * FROM `__keep_cloud_objects`;--> statement-breakpoint
INSERT INTO `poster_figures` SELECT * FROM `__keep_poster_figures`;--> statement-breakpoint
DROP TABLE `__keep_run_tags`;--> statement-breakpoint
DROP TABLE `__keep_analysis_revisions`;--> statement-breakpoint
DROP TABLE `__keep_analysis_metrics`;--> statement-breakpoint
DROP TABLE `__keep_cloud_objects`;--> statement-breakpoint
DROP TABLE `__keep_poster_figures`;--> statement-breakpoint
DROP TABLE `projects`;
