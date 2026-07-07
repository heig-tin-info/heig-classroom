CREATE TABLE "teacher_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teacher_grants_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "teacher_grants" ADD CONSTRAINT "teacher_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;