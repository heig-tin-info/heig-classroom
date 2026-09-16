CREATE TABLE "classroom_staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"classroom_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'teacher' NOT NULL,
	"user_id" uuid,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_staff" ADD CONSTRAINT "classroom_staff_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "classroom_staff_classroom_email_uq" ON "classroom_staff" USING btree ("classroom_id","email");--> statement-breakpoint
CREATE INDEX "classroom_staff_user_idx" ON "classroom_staff" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "classroom_staff_email_idx" ON "classroom_staff" USING btree ("email");