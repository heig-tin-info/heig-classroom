CREATE TABLE "classroom_notification_prefs" (
	"classroom_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"student_activity" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classroom_notification_prefs_classroom_id_user_id_pk" PRIMARY KEY("classroom_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "classroom_notification_prefs" ADD CONSTRAINT "classroom_notification_prefs_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_notification_prefs" ADD CONSTRAINT "classroom_notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;