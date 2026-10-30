CREATE TABLE `account_deletions` (
	`user_id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deleted_account_object_keys` (
	`r2_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`check_sequence` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_account_object_keys_check_idx` ON `deleted_account_object_keys` (`check_sequence`,`r2_key`);--> statement-breakpoint
CREATE INDEX `deleted_account_object_keys_user_idx` ON `deleted_account_object_keys` (`user_id`,`r2_key`);