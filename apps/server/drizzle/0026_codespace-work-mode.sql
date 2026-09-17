ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "work_mode" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_image" text;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "browser_exam_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN IF NOT EXISTS "codespace_sync_error" text;--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD COLUMN IF NOT EXISTS "codespace_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD COLUMN IF NOT EXISTS "codespace_max_active_sessions" integer DEFAULT 2 NOT NULL;