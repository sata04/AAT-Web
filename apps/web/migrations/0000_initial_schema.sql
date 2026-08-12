CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `analysis_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_revision_id` text NOT NULL,
	`inner_mean` text,
	`inner_std` text,
	`inner_start_time` text,
	`drag_mean` text,
	`drag_std` text,
	`drag_start_time` text,
	`window_size` text NOT NULL,
	`inner_sample_count` integer NOT NULL,
	`drag_sample_count` integer NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`g_quality_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`analysis_revision_id`) REFERENCES `analysis_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_revision_unique` ON `analysis_metrics` (`analysis_revision_id`);--> statement-breakpoint
CREATE TABLE `analysis_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`source_sha256` text NOT NULL,
	`config_hash` text NOT NULL,
	`config_json` text NOT NULL,
	`engine_version` text NOT NULL,
	`app_version` text NOT NULL,
	`snapshot_format_version` integer NOT NULL,
	`snapshot_object_id` text,
	`notes` text,
	`created_at` integer NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_run_revision_number_unique` ON `analysis_revisions` (`run_id`,`revision_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `revisions_run_identity_unique` ON `analysis_revisions` (`run_id`,`source_sha256`,`config_hash`,`engine_version`);--> statement-breakpoint
CREATE INDEX `revisions_run_created_idx` ON `analysis_revisions` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `revisions_owner_created_idx` ON `analysis_revisions` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`ip_address` text,
	`user_agent` text,
	`details` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_created_at_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE TABLE `cloud_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`r2_key` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`content_type` text NOT NULL,
	`original_filename` text,
	`run_id` text,
	`analysis_revision_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`analysis_revision_id`) REFERENCES `analysis_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_objects_r2_key_unique` ON `cloud_objects` (`r2_key`);--> statement-breakpoint
CREATE INDEX `cloud_objects_owner_kind_idx` ON `cloud_objects` (`owner_user_id`,`kind`);--> statement-breakpoint
CREATE INDEX `cloud_objects_run_idx` ON `cloud_objects` (`run_id`);--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`public_key` text NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`transports` text,
	`aaguid` text,
	`algorithm` integer NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_credential_id_unique` ON `passkey` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkey_user_id_idx` ON `passkey` (`user_id`);--> statement-breakpoint
CREATE TABLE `poster_figures` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_revision_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`preset_key` text NOT NULL,
	`preset_version` text NOT NULL,
	`spec_hash` text NOT NULL,
	`renderer_version` text,
	`status` text NOT NULL,
	`object_id` text,
	`error_code` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`analysis_revision_id`) REFERENCES `analysis_revisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poster_figures_auto_unique` ON `poster_figures` (`analysis_revision_id`,`preset_version`) WHERE kind = 'auto';--> statement-breakpoint
CREATE INDEX `poster_figures_revision_idx` ON `poster_figures` (`analysis_revision_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `poster_figures_status_idx` ON `poster_figures` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `poster_figures_owner_idx` ON `poster_figures` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `poster_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`preset_key` text NOT NULL,
	`preset_version` text NOT NULL,
	`spec_hash` text NOT NULL,
	`renderer_version` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `poster_presets_key_version_unique` ON `poster_presets` (`preset_key`,`preset_version`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_owner_idx` ON `projects` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `quota_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`bytes` integer NOT NULL,
	`purpose` text NOT NULL,
	`r2_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `quota_reservations_status_idx` ON `quota_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `quota_usage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`bytes_used` integer DEFAULT 0 NOT NULL,
	`bytes_reserved` integer DEFAULT 0 NOT NULL,
	`bytes_limit` integer NOT NULL,
	`object_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`window_start` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `registration_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`display_name` text NOT NULL,
	`note` text,
	`target_user_id` text,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claim_context_hash` text,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`used_at` integer,
	`used_by_user_id` text,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	FOREIGN KEY (`target_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `registration_invites_token_hash_unique` ON `registration_invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `registration_invites_status_idx` ON `registration_invites` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `registration_invites_target_user_idx` ON `registration_invites` (`target_user_id`);--> statement-breakpoint
CREATE TABLE `run_tags` (
	`run_id` text NOT NULL,
	`tag` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `tag`),
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_tags_tag_idx` ON `run_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`project_id` text,
	`run_code` text NOT NULL,
	`experiment_date` text,
	`suffix` text,
	`original_filename` text NOT NULL,
	`memo` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_owner_run_code_unique` ON `runs` (`owner_user_id`,`run_code`);--> statement-breakpoint
CREATE INDEX `runs_owner_experiment_date_idx` ON `runs` (`owner_user_id`,`experiment_date`);--> statement-breakpoint
CREATE INDEX `runs_owner_created_at_idx` ON `runs` (`owner_user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `system_flags` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_user_id` text,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text DEFAULT 'Viewer' NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE INDEX `user_role_idx` ON `user` (`role`);--> statement-breakpoint
CREATE INDEX `user_created_at_idx` ON `user` (`created_at`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE INDEX `verification_expires_at_idx` ON `verification` (`expires_at`);