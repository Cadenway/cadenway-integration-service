ALTER TABLE "git_links" ADD COLUMN "head_sha" text;--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "head_first_observed_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "head_last_observed_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "checks_attempt_id" bigint;--> statement-breakpoint
ALTER TABLE "git_links" ADD COLUMN "checks_completed_at_ms" bigint;--> statement-breakpoint
CREATE INDEX "git_links_request_lookup_index" ON "git_links" USING btree ("organization_id","receiver_id","identity_hash","task_key");--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_head_check" CHECK (("git_links"."head_sha" is null and "git_links"."head_first_observed_at_ms" is null and "git_links"."head_last_observed_at_ms" is null) or
          ("git_links"."head_sha" is not null and "git_links"."head_first_observed_at_ms" is not null and "git_links"."head_last_observed_at_ms" is not null and "git_links"."head_sha" ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' and "git_links"."head_first_observed_at_ms" between 0 and 9007199254740991 and "git_links"."head_last_observed_at_ms" between "git_links"."head_first_observed_at_ms" and 9007199254740991));--> statement-breakpoint
ALTER TABLE "git_links" ADD CONSTRAINT "git_links_checks_check" CHECK (("git_links"."checks_attempt_id" is null and "git_links"."checks_completed_at_ms" is null) or
          ("git_links"."head_sha" is not null and "git_links"."checks_attempt_id" is not null and "git_links"."checks_completed_at_ms" is not null and "git_links"."checks_attempt_id" between 1 and 9007199254740991 and "git_links"."checks_completed_at_ms" between "git_links"."head_first_observed_at_ms" and 9007199254740991));