CREATE TABLE "git_repository_mappings" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"receiver_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository_id" bigint NOT NULL,
	"installation_id" bigint,
	"space_id" uuid NOT NULL,
	"mapping_author_user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_repository_mappings_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "git_repository_mappings_provider_check" CHECK (("git_repository_mappings"."provider" = 'github' and "git_repository_mappings"."installation_id" is not null and "git_repository_mappings"."installation_id" > 0) or ("git_repository_mappings"."provider" = 'gitlab' and "git_repository_mappings"."installation_id" is null)),
	CONSTRAINT "git_repository_mappings_repository_id_check" CHECK ("git_repository_mappings"."repository_id" between 1 and 9007199254740991),
	CONSTRAINT "git_repository_mappings_installation_id_check" CHECK ("git_repository_mappings"."installation_id" is null or "git_repository_mappings"."installation_id" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "git_repository_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "git_webhook_deliveries" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"receiver_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"digest" text NOT NULL,
	"work" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_webhook_deliveries_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "git_webhook_deliveries_provider_check" CHECK ("git_webhook_deliveries"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_webhook_deliveries_digest_check" CHECK ("git_webhook_deliveries"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "git_webhook_deliveries_work_check" CHECK ("git_webhook_deliveries"."work" is null or jsonb_typeof("git_webhook_deliveries"."work") = 'object')
);
--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "git_webhook_delivery_ids" (
	"organization_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"delivery_id" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_webhook_delivery_ids_organization_id_receiver_id_provider_delivery_id_pk" PRIMARY KEY("organization_id","receiver_id","provider","delivery_id"),
	CONSTRAINT "git_webhook_delivery_ids_provider_check" CHECK ("git_webhook_delivery_ids"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_webhook_delivery_ids_length_check" CHECK (length("git_webhook_delivery_ids"."delivery_id") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "git_webhook_delivery_ids" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "git_webhook_deliveries_receipt_owner_unique" ON "git_webhook_deliveries" USING btree ("organization_id","receiver_id","provider","id");--> statement-breakpoint
ALTER TABLE "git_webhook_delivery_ids" ADD CONSTRAINT "git_webhook_delivery_ids_organization_id_receiver_id_provider_receipt_id_git_webhook_deliveries_organization_id_receiver_id_provider_id_fk" FOREIGN KEY ("organization_id","receiver_id","provider","receipt_id") REFERENCES "public"."git_webhook_deliveries"("organization_id","receiver_id","provider","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_repository_mappings_github_identity_unique" ON "git_repository_mappings" USING btree ("organization_id","receiver_id","installation_id","repository_id") WHERE "git_repository_mappings"."provider" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "git_repository_mappings_gitlab_identity_unique" ON "git_repository_mappings" USING btree ("organization_id","receiver_id","repository_id") WHERE "git_repository_mappings"."provider" = 'gitlab';--> statement-breakpoint
CREATE UNIQUE INDEX "git_repository_mappings_github_global_unique" ON "git_repository_mappings" USING btree ("receiver_id","installation_id","repository_id") WHERE "git_repository_mappings"."provider" = 'github';--> statement-breakpoint
CREATE UNIQUE INDEX "git_repository_mappings_gitlab_global_unique" ON "git_repository_mappings" USING btree ("receiver_id","repository_id") WHERE "git_repository_mappings"."provider" = 'gitlab';--> statement-breakpoint
CREATE UNIQUE INDEX "git_webhook_deliveries_github_digest_unique" ON "git_webhook_deliveries" USING btree ("organization_id","receiver_id","digest") WHERE "git_webhook_deliveries"."provider" = 'github';--> statement-breakpoint
CREATE POLICY "git_repository_mappings_tenant_isolation" ON "git_repository_mappings" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "git_webhook_deliveries_tenant_isolation" ON "git_webhook_deliveries" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "git_webhook_delivery_ids_tenant_isolation" ON "git_webhook_delivery_ids" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "git_repository_mappings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_webhook_delivery_ids" FORCE ROW LEVEL SECURITY;
