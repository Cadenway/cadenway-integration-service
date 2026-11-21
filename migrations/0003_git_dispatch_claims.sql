CREATE TABLE "git_dispatch_claims" (
	"organization_id" uuid NOT NULL,
	"id" uuid DEFAULT uuidv7() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"task_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"disposition" text,
	"task_id" uuid,
	"list_id" uuid,
	"space_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_dispatch_claims_organization_id_id_pk" PRIMARY KEY("organization_id","id"),
	CONSTRAINT "git_dispatch_claims_task_key_check" CHECK ("git_dispatch_claims"."task_key" ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'),
	CONSTRAINT "git_dispatch_claims_result_check" CHECK (("git_dispatch_claims"."status" = 'completed' and "git_dispatch_claims"."disposition" is not null and "git_dispatch_claims"."disposition" in ('applied','no_op') and "git_dispatch_claims"."task_id" is not null and "git_dispatch_claims"."list_id" is not null and "git_dispatch_claims"."space_id" is not null) or ("git_dispatch_claims"."status" in ('pending','closed') and "git_dispatch_claims"."disposition" is null and "git_dispatch_claims"."task_id" is null and "git_dispatch_claims"."list_id" is null and "git_dispatch_claims"."space_id" is null))
);
--> statement-breakpoint
ALTER TABLE "git_dispatch_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD COLUMN "receiver_revision" bigint;--> statement-breakpoint
ALTER TABLE "git_dispatch_claims" ADD CONSTRAINT "git_dispatch_claims_organization_id_delivery_id_git_webhook_deliveries_organization_id_id_fk" FOREIGN KEY ("organization_id","delivery_id") REFERENCES "public"."git_webhook_deliveries"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_dispatch_claims_delivery_task_unique" ON "git_dispatch_claims" USING btree ("organization_id","delivery_id","task_key");--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD CONSTRAINT "git_webhook_deliveries_receiver_revision_check" CHECK ("git_webhook_deliveries"."receiver_revision" is null or "git_webhook_deliveries"."receiver_revision" between 1 and 9007199254740991);--> statement-breakpoint
CREATE POLICY "git_dispatch_claims_tenant_isolation" ON "git_dispatch_claims" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "git_dispatch_claims" FORCE ROW LEVEL SECURITY;
