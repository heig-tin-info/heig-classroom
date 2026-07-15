ALTER TABLE "assignments" ADD COLUMN "grades_validated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "grades_validated_by" uuid;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "teacher_points" double precision;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "teacher_comment" text;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "teacher_graded_by" uuid;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "teacher_graded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_grades_validated_by_users_id_fk" FOREIGN KEY ("grades_validated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_teacher_graded_by_users_id_fk" FOREIGN KEY ("teacher_graded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;