ALTER TABLE "assignments" ADD COLUMN "source_pushed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "sync_pr_number" integer;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "sync_pr_state" text;