CREATE TABLE "student_repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"github_repo_id" bigint,
	"full_name" text,
	"default_branch" text,
	"provision_status" text DEFAULT 'pending' NOT NULL,
	"provision_error" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invitation_status" text DEFAULT 'none' NOT NULL,
	"locked_at" timestamp with time zone,
	"ruleset_id" bigint,
	"last_commit_sha" text,
	"last_commit_at" timestamp with time zone,
	"ci_status" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "student_repos_github_repo_id_unique" UNIQUE("github_repo_id")
);
--> statement-breakpoint
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_repos_assignment_user_uq" ON "student_repos" USING btree ("assignment_id","user_id");