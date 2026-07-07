CREATE TABLE "assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"grace_minutes" integer DEFAULT 30 NOT NULL,
	"source_repo_id" bigint NOT NULL,
	"source_full_name" text NOT NULL,
	"squashed_repo_id" bigint,
	"squashed_full_name" text,
	"source_strategy" text DEFAULT 'squash' NOT NULL,
	"deadline_strategy" text DEFAULT 'lock' NOT NULL,
	"branches" text[] NOT NULL,
	"protected_files" text[] NOT NULL,
	"source_ahead_sha" text,
	"deadline_applied_at" timestamp with time zone,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignments_classroom_slug_uq" ON "assignments" USING btree ("classroom_id","slug");--> statement-breakpoint
CREATE INDEX "assignments_deadline_pending_idx" ON "assignments" USING btree ("deadline_at") WHERE "assignments"."state" = 'published' AND "assignments"."deadline_applied_at" IS NULL;--> statement-breakpoint
CREATE INDEX "assignments_freeze_pending_idx" ON "assignments" USING btree ("deadline_at") WHERE "assignments"."deadline_applied_at" IS NOT NULL AND "assignments"."frozen_at" IS NULL;