CREATE TABLE "assignment_group_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assignment_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "group_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assignments" ADD COLUMN "group_max_size" integer;--> statement-breakpoint
ALTER TABLE "student_repos" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_group_id_assignment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."assignment_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_group_members" ADD CONSTRAINT "assignment_group_members_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assignment_groups" ADD CONSTRAINT "assignment_groups_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_group_members_assignment_enrollment_uq" ON "assignment_group_members" USING btree ("assignment_id","enrollment_id");--> statement-breakpoint
CREATE INDEX "assignment_group_members_group_idx" ON "assignment_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_groups_assignment_name_uq" ON "assignment_groups" USING btree ("assignment_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_groups_assignment_slug_uq" ON "assignment_groups" USING btree ("assignment_id","slug");--> statement-breakpoint
ALTER TABLE "student_repos" ADD CONSTRAINT "student_repos_group_id_assignment_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."assignment_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_repos_group_idx" ON "student_repos" USING btree ("group_id");