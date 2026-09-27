CREATE TABLE "classroom_journals" (
	"classroom_id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attached_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"cached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_pages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"path" text NOT NULL,
	"parent_path" text NOT NULL,
	"sort_key" text NOT NULL,
	"title" text NOT NULL,
	"front_matter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob_sha" text NOT NULL,
	"markdown" text NOT NULL,
	"html" text NOT NULL,
	"toc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"visible_from" timestamp with time zone,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"github_repo_id" bigint,
	"full_name" text NOT NULL,
	"ref" text DEFAULT 'main' NOT NULL,
	"root_path" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_commit_sha" text,
	"last_synced_at" timestamp with time zone,
	"sync_status" text DEFAULT 'pending' NOT NULL,
	"sync_error" text
);
--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_classroom_id_classrooms_id_fk" FOREIGN KEY ("classroom_id") REFERENCES "public"."classrooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classroom_journals" ADD CONSTRAINT "classroom_journals_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_assets" ADD CONSTRAINT "journal_assets_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_pages" ADD CONSTRAINT "journal_pages_journal_id_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journals" ADD CONSTRAINT "journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_assets_journal_path_uq" ON "journal_assets" USING btree ("journal_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_pages_journal_path_uq" ON "journal_pages" USING btree ("journal_id","path");--> statement-breakpoint
CREATE INDEX "journal_pages_nav_idx" ON "journal_pages" USING btree ("journal_id","parent_path","sort_key");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_repo_ref_uq" ON "journals" USING btree ("github_repo_id","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "journals_full_name_ref_uq" ON "journals" USING btree (lower("full_name"),"ref");