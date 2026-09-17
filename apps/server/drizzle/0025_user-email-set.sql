CREATE TABLE "user_emails" (
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"source" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_user_id_email_pk" PRIMARY KEY("user_id","email")
);
--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_emails_email_idx" ON "user_emails" USING btree ("email");--> statement-breakpoint
-- GH-11 backfill. Purely additive: it derives the new table from data that
-- already exists and touches no existing row. Without it every account would
-- match nothing until its next login.
-- 1. The login address of every account, with the verification the IdP gave.
INSERT INTO "user_emails" ("user_id", "email", "source", "verified")
SELECT "id", lower(trim("email")), 'login', "email_verified"
FROM "users"
WHERE trim("email") <> '' AND "anonymized_at" IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- 2. The institutional addresses already captured by 0024, so the students
-- who signed in during the observation phase are matched without having to
-- sign in again.
INSERT INTO "user_emails" ("user_id", "email", "source", "verified")
SELECT c."user_id", lower(trim(m.value)), 'swissEduIDLinkedAffiliationMail', true
FROM "user_idp_claims" c
CROSS JOIN LATERAL jsonb_array_elements_text(
  CASE jsonb_typeof(c."claims" -> 'swissEduIDLinkedAffiliationMail')
    WHEN 'array' THEN c."claims" -> 'swissEduIDLinkedAffiliationMail'
    ELSE '[]'::jsonb
  END
) AS m(value)
WHERE trim(m.value) <> ''
ON CONFLICT DO NOTHING;
