CREATE TABLE "bot_commits" (
	"student_repo_id" uuid NOT NULL,
	"sha" char(40) NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"branch" text NOT NULL,
	"head_sha" char(40) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_bot" boolean DEFAULT false NOT NULL,
	"forced" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reverts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"student_repo_id" uuid NOT NULL,
	"revert_sha" char(40) NOT NULL,
	"files" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_commits" ADD CONSTRAINT "bot_commits_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_receipts" ADD CONSTRAINT "push_receipts_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reverts" ADD CONSTRAINT "reverts_student_repo_id_student_repos_id_fk" FOREIGN KEY ("student_repo_id") REFERENCES "public"."student_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_commits_pk" ON "bot_commits" USING btree ("student_repo_id","sha");--> statement-breakpoint
CREATE UNIQUE INDEX "push_receipts_repo_sha_uq" ON "push_receipts" USING btree ("student_repo_id","head_sha");--> statement-breakpoint
CREATE INDEX "reverts_repo_time_idx" ON "reverts" USING btree ("student_repo_id","created_at");