ALTER TABLE "organizations" ALTER COLUMN "github_org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_login_unique" UNIQUE("login");