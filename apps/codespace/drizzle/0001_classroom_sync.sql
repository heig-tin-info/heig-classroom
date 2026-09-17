CREATE TABLE `launch_tokens_used` (
	`jti` text PRIMARY KEY NOT NULL,
	`exp` integer NOT NULL,
	`used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `launch_tokens_used_exp_idx` ON `launch_tokens_used` (`exp`);--> statement-breakpoint
ALTER TABLE `assignments` ADD `teacher_id` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `teacher_email` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `max_active_sessions` integer;--> statement-breakpoint
ALTER TABLE `assignments` ADD `classroom_id` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `classroom_name` text;--> statement-breakpoint
ALTER TABLE `assignments` ADD `source_repo` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `teacher_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `launch_jti` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `target_repo` text;--> statement-breakpoint
CREATE INDEX `sessions_teacher_idx` ON `sessions` (`teacher_id`,`state`);--> statement-breakpoint
ALTER TABLE `users` ADD `github_login` text;