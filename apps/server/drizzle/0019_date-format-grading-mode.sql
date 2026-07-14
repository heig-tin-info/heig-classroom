ALTER TABLE "assignments" ADD COLUMN "grading_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "date_format" text;