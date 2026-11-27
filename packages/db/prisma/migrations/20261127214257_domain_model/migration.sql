-- CreateEnum
CREATE TYPE "vertical" AS ENUM ('b2b_saas', 'rehab', 'clinic', 'local_services');

-- CreateEnum
CREATE TYPE "triage_disposition" AS ENUM ('qualified', 'nurture', 'spam', 'duplicate', 'needs_review');

-- CreateEnum
CREATE TYPE "lead_source" AS ENUM ('web_form', 'hubspot_direct');

-- CreateEnum
CREATE TYPE "agent_run_mode" AS ENUM ('shadow', 'propose');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('approved', 'rejected');

-- CreateEnum
CREATE TYPE "eval_split" AS ENUM ('dev', 'test');

-- CreateTable
CREATE TABLE "site" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "vertical" "vertical" NOT NULL,
    "time_zone" TEXT NOT NULL,
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "routing_config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "site_id" UUID,
    "session_id" UUID,
    "source" "lead_source" NOT NULL,
    "browser_event_id" UUID,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "phone" TEXT,
    "company_name" TEXT,
    "job_title" TEXT,
    "message" TEXT,
    "submission" JSONB,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL,
    "submitted_time_zone" TEXT NOT NULL,
    "submitted_at_local" TEXT NOT NULL,
    "hubspot_portal_id" BIGINT,
    "hubspot_contact_id" BIGINT,
    "triage_disposition" "triage_disposition",
    "disposition_at" TIMESTAMPTZ(3),
    "synthetic_key" TEXT,
    "pii_purged_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_event" (
    "id" BIGSERIAL NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "portal_id" BIGINT NOT NULL,
    "app_id" BIGINT,
    "subscription_id" BIGINT NOT NULL,
    "subscription_type" TEXT NOT NULL,
    "object_type_id" TEXT,
    "object_id" BIGINT NOT NULL,
    "property_name" TEXT,
    "property_value" TEXT,
    "event_id" BIGINT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "change_source" TEXT,
    "source_id" TEXT,
    "attempt_number" INTEGER NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID,

    CONSTRAINT "crm_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "crm_event_id" BIGINT,
    "workflow_id" TEXT NOT NULL,
    "workflow_version" INTEGER NOT NULL,
    "mode" "agent_run_mode" NOT NULL,
    "proposal_run_id" TEXT NOT NULL,
    "resume_run_id" TEXT,
    "input_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" JSONB,
    "proposed_disposition" "triage_disposition",
    "confidence" DOUBLE PRECISION,
    "cost_usd" DECIMAL(12,6),
    "latency_ms" INTEGER,
    "error" JSONB,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_run_id" UUID NOT NULL,
    "sim_context_id" TEXT NOT NULL,
    "diff" JSONB NOT NULL,
    "decision" "approval_decision",
    "approver" TEXT,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "resumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_case" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" TEXT NOT NULL,
    "split" "eval_split" NOT NULL,
    "category" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expected" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "promoted_from_approval_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_run" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "workflow_id" TEXT NOT NULL,
    "workflow_version" INTEGER NOT NULL,
    "split" "eval_split" NOT NULL,
    "model" TEXT,
    "source_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB,
    "report_path" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "eval_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_result" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "eval_run_id" UUID NOT NULL,
    "eval_case_id" UUID NOT NULL,
    "sim_run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "output" JSONB,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "latency_ms" INTEGER,
    "cost_usd" DECIMAL(12,6),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "site_key_key" ON "site"("key");

-- CreateIndex
CREATE UNIQUE INDEX "site_domain_key" ON "site"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "lead_browser_event_id_key" ON "lead"("browser_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_synthetic_key_key" ON "lead"("synthetic_key");

-- CreateIndex
CREATE INDEX "lead_email_idx" ON "lead"("email");

-- CreateIndex
CREATE INDEX "lead_site_id_submitted_at_idx" ON "lead"("site_id", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "lead_hubspot_portal_id_hubspot_contact_id_key" ON "lead"("hubspot_portal_id", "hubspot_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_event_dedupe_key_key" ON "crm_event"("dedupe_key");

-- CreateIndex
CREATE INDEX "crm_event_portal_id_object_id_occurred_at_idx" ON "crm_event"("portal_id", "object_id", "occurred_at");

-- CreateIndex
CREATE INDEX "crm_event_lead_id_idx" ON "crm_event"("lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_proposal_run_id_key" ON "agent_run"("proposal_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_resume_run_id_key" ON "agent_run"("resume_run_id");

-- CreateIndex
CREATE INDEX "agent_run_lead_id_created_at_idx" ON "agent_run"("lead_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_run_workflow_id_workflow_version_idx" ON "agent_run"("workflow_id", "workflow_version");

-- CreateIndex
CREATE INDEX "agent_run_status_idx" ON "agent_run"("status");

-- CreateIndex
CREATE UNIQUE INDEX "approval_agent_run_id_key" ON "approval"("agent_run_id");

-- CreateIndex
CREATE INDEX "approval_decision_resumed_at_idx" ON "approval"("decision", "resumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "eval_case_key_key" ON "eval_case"("key");

-- CreateIndex
CREATE UNIQUE INDEX "eval_case_promoted_from_approval_id_key" ON "eval_case"("promoted_from_approval_id");

-- CreateIndex
CREATE INDEX "eval_case_split_category_idx" ON "eval_case"("split", "category");

-- CreateIndex
CREATE INDEX "eval_run_workflow_id_workflow_version_split_idx" ON "eval_run"("workflow_id", "workflow_version", "split");

-- CreateIndex
CREATE UNIQUE INDEX "eval_result_sim_run_id_key" ON "eval_result"("sim_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "eval_result_eval_run_id_eval_case_id_key" ON "eval_result"("eval_run_id", "eval_case_id");

-- AddForeignKey
ALTER TABLE "lead" ADD CONSTRAINT "lead_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_event" ADD CONSTRAINT "crm_event_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_crm_event_id_fkey" FOREIGN KEY ("crm_event_id") REFERENCES "crm_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval" ADD CONSTRAINT "approval_agent_run_id_fkey" FOREIGN KEY ("agent_run_id") REFERENCES "agent_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_case" ADD CONSTRAINT "eval_case_promoted_from_approval_id_fkey" FOREIGN KEY ("promoted_from_approval_id") REFERENCES "approval"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_result" ADD CONSTRAINT "eval_result_eval_run_id_fkey" FOREIGN KEY ("eval_run_id") REFERENCES "eval_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_result" ADD CONSTRAINT "eval_result_eval_case_id_fkey" FOREIGN KEY ("eval_case_id") REFERENCES "eval_case"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints, added by hand: Prisma can't declare them, and `migrate dev` doesn't drop what it
-- doesn't model. Each one guards a rule from PLAN.md section 6 or the repo CLAUDE.md.

-- Synthetic data only: lead emails use reserved domains (RFC 2606 / RFC 6761). NULL after a privacy purge.
ALTER TABLE "lead" ADD CONSTRAINT "lead_email_reserved_domain"
  CHECK ("email" IS NULL OR "email" ~ '^[^@\s]+@((([a-z0-9-]+\.)*example\.(com|org|net))|(([a-z0-9-]+\.)+test))$');
ALTER TABLE "lead" ADD CONSTRAINT "lead_email_lowercase"
  CHECK ("email" IS NULL OR "email" = lower("email"));
ALTER TABLE "lead" ADD CONSTRAINT "lead_pii_purged"
  CHECK ("pii_purged_at" IS NULL OR ("email" IS NULL AND "first_name" IS NULL AND "last_name" IS NULL
    AND "phone" IS NULL AND "message" IS NULL AND "submission" IS NULL));
ALTER TABLE "lead" ADD CONSTRAINT "lead_hubspot_ids_together"
  CHECK (("hubspot_portal_id" IS NULL) = ("hubspot_contact_id" IS NULL));
ALTER TABLE "lead" ADD CONSTRAINT "lead_web_form_has_event_id"
  CHECK ("source" <> 'web_form' OR "browser_event_id" IS NOT NULL);
ALTER TABLE "lead" ADD CONSTRAINT "lead_disposition_dated"
  CHECK (("triage_disposition" IS NULL) = ("disposition_at" IS NULL));

ALTER TABLE "crm_event" ADD CONSTRAINT "crm_event_dedupe_key_format"
  CHECK ("dedupe_key" ~ '^v1:[0-9a-f]{64}$');
ALTER TABLE "crm_event" ADD CONSTRAINT "crm_event_attempt_nonnegative"
  CHECK ("attempt_number" >= 0);

-- `unknown` is a timeout or dropped connection: never `failed`, never `completed`.
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_status_known"
  CHECK ("status" IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled', 'unknown'));
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_confidence_range"
  CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_version_positive"
  CHECK ("workflow_version" >= 1);
-- Shadow runs stop before the Human block, so they can never be resumed.
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_shadow_never_resumes"
  CHECK ("mode" <> 'shadow' OR "resume_run_id" IS NULL);

ALTER TABLE "approval" ADD CONSTRAINT "approval_decided_together"
  CHECK (("decision" IS NULL AND "approver" IS NULL AND "decided_at" IS NULL)
    OR ("decision" IS NOT NULL AND "approver" IS NOT NULL AND "decided_at" IS NOT NULL));
ALTER TABLE "approval" ADD CONSTRAINT "approval_resumed_after_decision"
  CHECK ("resumed_at" IS NULL OR "decided_at" IS NOT NULL);

ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_status_known"
  CHECK ("status" IN ('running', 'completed', 'failed'));
ALTER TABLE "eval_run" ADD CONSTRAINT "eval_run_version_positive"
  CHECK ("workflow_version" >= 1);
ALTER TABLE "eval_result" ADD CONSTRAINT "eval_result_status_known"
  CHECK ("status" IN ('completed', 'failed', 'cancelled', 'unknown'));
