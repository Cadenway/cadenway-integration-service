CREATE TABLE "git_webhook_receivers" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_webhook_receivers_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "git_webhook_receivers_provider_check" CHECK ("git_webhook_receivers"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_webhook_receivers_revision_check" CHECK ("git_webhook_receivers"."revision" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "git_webhook_receivers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "git_webhook_receivers_global_id_unique" ON "git_webhook_receivers" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "git_webhook_receivers_tenant_id_provider_unique" ON "git_webhook_receivers" USING btree ("organization_id","id","provider");--> statement-breakpoint
ALTER TABLE "git_repository_mappings" ADD CONSTRAINT "git_repository_mappings_organization_id_receiver_id_provider_git_webhook_receivers_organization_id_id_provider_fk" FOREIGN KEY ("organization_id","receiver_id","provider") REFERENCES "public"."git_webhook_receivers"("organization_id","id","provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD CONSTRAINT "git_webhook_deliveries_organization_id_receiver_id_provider_git_webhook_receivers_organization_id_id_provider_fk" FOREIGN KEY ("organization_id","receiver_id","provider") REFERENCES "public"."git_webhook_receivers"("organization_id","id","provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "git_webhook_receivers_tenant_isolation" ON "git_webhook_receivers" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "git_webhook_receivers" FORCE ROW LEVEL SECURITY;
