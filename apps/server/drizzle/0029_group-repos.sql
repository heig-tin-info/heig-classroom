DROP INDEX "student_repos_assignment_user_uq";--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "provision_claimed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "student_repos_assignment_group_uq" ON "student_repos" USING btree ("assignment_id","group_id") WHERE "student_repos"."group_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "student_repos_assignment_user_uq" ON "student_repos" USING btree ("assignment_id","user_id") WHERE "student_repos"."group_id" IS NULL;