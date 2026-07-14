CREATE TABLE "assignment_milestones" (
	"id" uuid PRIMARY KEY NOT NULL,
	"assignment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"offset_days" integer,
	"dispatched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "assignment_milestones" ADD CONSTRAINT "assignment_milestones_assignment_id_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assignment_milestones_assignment_name_uq" ON "assignment_milestones" USING btree ("assignment_id","name");--> statement-breakpoint
CREATE INDEX "assignment_milestones_due_pending_idx" ON "assignment_milestones" USING btree ("due_at") WHERE "assignment_milestones"."dispatched_at" IS NULL;