CREATE TABLE "git_links" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"receiver_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"task_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"identity_hash" text NOT NULL,
	"identity" jsonb NOT NULL,
	"status" text NOT NULL,
	"version" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_links_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "git_links_provider_check" CHECK ("git_links"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_links_task_key_check" CHECK ("git_links"."task_key" ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'),
	CONSTRAINT "git_links_identity_hash_check" CHECK ("git_links"."identity_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "git_links_identity_check" CHECK (jsonb_typeof("git_links"."identity") = 'object'),
	CONSTRAINT "git_links_status_check" CHECK ("git_links"."status" in ('created', 'open', 'merged')),
	CONSTRAINT "git_links_version_check" CHECK ("git_links"."version" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "git_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "git_purged_tasks" (
	"organization_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_purged_tasks_organization_id_task_key_pk" PRIMARY KEY("organization_id","task_key"),
	CONSTRAINT "git_purged_tasks_key_check" CHECK ("git_purged_tasks"."task_key" ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$')
);
--> statement-breakpoint
ALTER TABLE "git_purged_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_organization_id_receiver_id_provider_git_webhook_receivers_organization_id_id_provider_fk" FOREIGN KEY ("organization_id","receiver_id","provider") REFERENCES "public"."git_webhook_receivers"("organization_id","id","provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_links_identity_unique" ON "git_links" USING btree ("organization_id","receiver_id","task_id","identity_hash");--> statement-breakpoint
CREATE INDEX "git_links_tenant_task_index" ON "git_links" USING btree ("organization_id","task_id","id");--> statement-breakpoint
CREATE INDEX "git_links_tenant_task_key_index" ON "git_links" USING btree ("organization_id","task_key","id");--> statement-breakpoint
CREATE POLICY "git_links_tenant_isolation" ON "git_links" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "git_purged_tasks_tenant_isolation" ON "git_purged_tasks" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
ALTER TABLE "git_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_purged_tasks" FORCE ROW LEVEL SECURITY;
