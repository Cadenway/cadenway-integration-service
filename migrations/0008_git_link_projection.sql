-- Fail fast instead of queueing behind long transactions on git_links. The new git_links
-- indexes are built concurrently and its new checks validated by src/migrate.ts after this
-- transaction commits.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE SEQUENCE "public"."git_webhook_admission_sequence" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;
--> statement-breakpoint
CREATE TABLE "git_check_observations" (
	"organization_id" uuid NOT NULL,
	"receiver_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"repository_id" bigint NOT NULL,
	"head_sha" text NOT NULL,
	"attempt_id" bigint NOT NULL,
	"status" text NOT NULL,
	"conclusion" text,
	"job_total" bigint,
	"job_failed" bigint,
	"observed_at_ms" bigint NOT NULL,
	"completed_at_ms" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_check_observations_organization_id_receiver_id_repository_id_head_sha_attempt_id_pk" PRIMARY KEY("organization_id","receiver_id","repository_id","head_sha","attempt_id"),
	CONSTRAINT "git_check_observations_provider_check" CHECK ("git_check_observations"."provider" in ('github', 'gitlab')),
	CONSTRAINT "git_check_observations_identity_check" CHECK ("git_check_observations"."repository_id" between 1 and 9007199254740991 and "git_check_observations"."attempt_id" between 1 and 9007199254740991 and "git_check_observations"."head_sha" ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
	CONSTRAINT "git_check_observations_status_check" CHECK (("git_check_observations"."provider" = 'github' and "git_check_observations"."status" in ('requested', 'queued', 'in_progress', 'pending', 'waiting', 'completed') and "git_check_observations"."job_total" is null and "git_check_observations"."job_failed" is null and (("git_check_observations"."status" = 'completed') = ("git_check_observations"."conclusion" is not null))) or
          ("git_check_observations"."provider" = 'gitlab' and "git_check_observations"."status" in ('created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'success', 'failed', 'canceled', 'skipped') and "git_check_observations"."conclusion" is null)),
	CONSTRAINT "git_check_observations_times_check" CHECK ("git_check_observations"."observed_at_ms" between 0 and 9007199254740991 and ("git_check_observations"."completed_at_ms" is null or "git_check_observations"."completed_at_ms" between 0 and 9007199254740991) and ("git_check_observations"."job_total" is null or "git_check_observations"."job_total" between 0 and 9007199254740991) and ("git_check_observations"."job_failed" is null or "git_check_observations"."job_failed" between 0 and "git_check_observations"."job_total"))
);
--> statement-breakpoint
ALTER TABLE "git_check_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE "git_merge_intents" (
	"organization_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"command_key" text NOT NULL,
	"task_key" text NOT NULL,
	"mapping" jsonb NOT NULL,
	"target_status" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"disposition" text,
	"reason" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"window_started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"reported_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_merge_intents_organization_id_link_id_pk" PRIMARY KEY("organization_id","link_id"),
	CONSTRAINT "git_merge_intents_task_key_check" CHECK ("git_merge_intents"."task_key" ~ '^[A-Z]{2,5}-[1-9][0-9]{0,8}$'),
	CONSTRAINT "git_merge_intents_command_key_check" CHECK (length("git_merge_intents"."command_key") between 1 and 255 and jsonb_typeof("git_merge_intents"."mapping") = 'object'),
	CONSTRAINT "git_merge_intents_result_check" CHECK (("git_merge_intents"."status" = 'pending' and "git_merge_intents"."disposition" is null and "git_merge_intents"."reason" is null and "git_merge_intents"."target_status" = 'done') or
          ("git_merge_intents"."status" = 'handled' and ("git_merge_intents"."disposition" is null) <> ("git_merge_intents"."reason" is null) and ("git_merge_intents"."disposition" is null or "git_merge_intents"."disposition" in ('applied', 'no_op')))),
	CONSTRAINT "git_merge_intents_attempts_check" CHECK ("git_merge_intents"."attempts" between 0 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "git_merge_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "git_links" DROP CONSTRAINT "git_links_checks_check";
--> statement-breakpoint
ALTER TABLE "git_webhook_deliveries" ADD COLUMN "admission_sequence" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "checks" jsonb;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "lifecycle_observed_at_ms" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "lifecycle_admission_sequence" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "head_admission_sequence" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "draft" boolean;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "url" text;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "repository" jsonb;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "source_branch" text;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "author" jsonb;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "review_requested" boolean;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "additions" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "deletions" bigint;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "link_source" text;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "member_observed_at_ms" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "member_admission_sequence" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "reconciliation_pending_since" timestamp (3) with time zone;
--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "reconciliation_reported_at" timestamp (3) with time zone;
--> statement-breakpoint
ALTER TABLE "git_check_observations" ADD CONSTRAINT "git_check_observations_organization_id_receiver_id_provider_git_webhook_receivers_organization_id_id_provider_fk" FOREIGN KEY ("organization_id","receiver_id","provider") REFERENCES "public"."git_webhook_receivers"("organization_id","id","provider") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "git_merge_intents" ADD CONSTRAINT "git_merge_intents_organization_id_link_id_git_links_organization_id_id_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."git_links"("organization_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "git_check_observations_updated_index" ON "git_check_observations" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX "git_merge_intents_pending_index" ON "git_merge_intents" USING btree ("window_started_at") WHERE "git_merge_intents"."status" = 'pending' and "git_merge_intents"."reported_at" is null;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_checks_completed_check" CHECK ("git_links"."checks_completed_at_ms" is null or "git_links"."checks_completed_at_ms" between 0 and 9007199254740991) NOT VALID;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_aggregate_check" CHECK ("git_links"."checks" is null or ("git_links"."head_sha" is not null and jsonb_typeof("git_links"."checks") = 'object')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_lifecycle_observed_check" CHECK ("git_links"."lifecycle_observed_at_ms" is null or "git_links"."lifecycle_observed_at_ms" between 0 and 9007199254740991) NOT VALID;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_line_counts_check" CHECK (("git_links"."additions" is null or "git_links"."additions" between 0 and 9007199254740991) and ("git_links"."deletions" is null or "git_links"."deletions" between 0 and 9007199254740991)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_link_source_check" CHECK ("git_links"."link_source" is null or "git_links"."link_source" in ('branch', 'title', 'description', 'commit')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_members_check" CHECK (jsonb_typeof("git_links"."member_observed_at_ms") = 'object' and ("git_links"."repository" is null or jsonb_typeof("git_links"."repository") = 'object') and ("git_links"."author" is null or jsonb_typeof("git_links"."author") = 'object')) NOT VALID;
--> statement-breakpoint
CREATE POLICY "git_check_observations_tenant_isolation" ON "git_check_observations" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
CREATE POLICY "git_merge_intents_tenant_isolation" ON "git_merge_intents" AS PERMISSIVE FOR ALL TO public USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on') WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid or current_setting('app.system_access', true) = 'on');
--> statement-breakpoint
ALTER TABLE "git_check_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "git_merge_intents" FORCE ROW LEVEL SECURITY;
