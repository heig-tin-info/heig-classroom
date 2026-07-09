CREATE TABLE "grade_dispatches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"milestone_id" uuid,
	"sha" char(40) NOT NULL,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "llm_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grade_runs" ADD COLUMN "kind" text DEFAULT 'ci' NOT NULL;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "llm_grade_run_id" uuid;--> statement-breakpoint
ALTER TABLE "grade_dispatches" ADD CONSTRAINT "grade_dispatches_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_dispatches_repo_trigger_uq" ON "grade_dispatches" USING btree ("student_repo_id","trigger",coalesce("milestone_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "assignments_llm_dispatch_pending_idx" ON "assignments" USING btree ("frozen_at") WHERE "assignments"."frozen_at" IS NOT NULL AND "assignments"."llm_dispatched_at" IS NULL;--> statement-breakpoint
-- Assignments already frozen before this feature shipped must not fire a
-- retroactive LLM review: mark them as already dispatched.
UPDATE "assignments" SET "llm_dispatched_at" = "frozen_at" WHERE "frozen_at" IS NOT NULL;
