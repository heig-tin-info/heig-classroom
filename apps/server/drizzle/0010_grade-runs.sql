CREATE TABLE "grade_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"workflow_run_id" bigint NOT NULL,
	"run_attempt" integer DEFAULT 1 NOT NULL,
	"head_branch" text NOT NULL,
	"head_sha" char(40) NOT NULL,
	"conclusion" text NOT NULL,
	"grade_points" double precision,
	"grade_max" double precision,
	"parse_status" text NOT NULL,
	"after_deadline" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "current_grade_run_id" uuid;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "frozen_grade_run_id" uuid;--> statement-breakpoint
ALTER TABLE "grade_runs" ADD CONSTRAINT "grade_runs_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grade_runs_repo_run_attempt_uq" ON "grade_runs" USING btree ("student_repo_id","workflow_run_id","run_attempt");--> statement-breakpoint
CREATE INDEX "grade_runs_selection_idx" ON "grade_runs" USING btree ("student_repo_id","completed_at");