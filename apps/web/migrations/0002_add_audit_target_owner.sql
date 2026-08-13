-- Hand-corrected after generation: drizzle-kit emits SQLite ADD COLUMN with a bare
-- `REFERENCES user(id)` and drops the referential action, which would leave this foreign key on
-- NO ACTION. Deleting a user would then fail as soon as anything had been audited about their
-- data. `ON DELETE set null` matches worker/db/schema.ts and 0002_snapshot.json.
ALTER TABLE `audit_logs` ADD `target_owner_user_id` text REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `audit_logs_target_owner_idx` ON `audit_logs` (`target_owner_user_id`,`created_at`);
