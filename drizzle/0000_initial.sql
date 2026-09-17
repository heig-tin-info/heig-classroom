CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`mode` text DEFAULT 'lab' NOT NULL,
	`image` text NOT NULL,
	`upload_pack` integer DEFAULT true NOT NULL,
	`template_repo` text,
	`target_repo` text,
	`target_repo_pattern` text,
	`opens_at` integer,
	`closes_at` integer,
	`config_key` text,
	`beks` text DEFAULT '[]' NOT NULL,
	`seb_config` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`student` text NOT NULL,
	`assignment` text NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`old_sha` text,
	`received_at` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`relayed_at` integer,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `push_events_state_idx` ON `push_events` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `push_events_session_idx` ON `push_events` (`session_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`student` text NOT NULL,
	`assignment_id` text NOT NULL,
	`container_id` text,
	`container_name` text,
	`container_ip` text,
	`volume_dir` text NOT NULL,
	`state` text DEFAULT 'starting' NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`cookie_token` text NOT NULL,
	`seb_verified` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_pair_idx` ON `sessions` (`student`,`assignment_id`,`state`);--> statement-breakpoint
CREATE INDEX `sessions_state_idx` ON `sessions` (`state`,`last_seen`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`oidc_sub` text NOT NULL,
	`login` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'student' NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_sub_idx` ON `users` (`oidc_sub`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_idx` ON `users` (`login`);