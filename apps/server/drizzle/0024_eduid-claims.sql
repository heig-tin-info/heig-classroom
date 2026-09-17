CREATE TABLE "user_idp_claims" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"claims" jsonb NOT NULL,
	"affiliations" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_idp_claims" ADD CONSTRAINT "user_idp_claims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;