CREATE TABLE `deleted_account_object_keys` (
	`r2_key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`last_checked_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `deleted_account_object_keys_checked_idx` ON `deleted_account_object_keys` (`last_checked_at`);