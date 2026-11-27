-- AlterTable
ALTER TABLE "oauth_token" ADD COLUMN     "installed_via" TEXT NOT NULL DEFAULT 'app_start',
ADD COLUMN     "last_refresh_error" JSONB,
ADD COLUMN     "last_refresh_error_at" TIMESTAMPTZ(3),
ADD COLUMN     "last_refreshed_at" TIMESTAMPTZ(3),
ADD COLUMN     "refresh_token_rotated_at" TIMESTAMPTZ(3);

-- CHECK constraints, added by hand (Prisma can't declare them; `migrate dev` doesn't drop what it doesn't
-- model). Additive: existing rows already satisfy both.

-- Only the two install paths of docs/adr/0006-hubspot-initiated-installs.md.
ALTER TABLE "oauth_token" ADD CONSTRAINT "oauth_token_installed_via_known"
  CHECK ("installed_via" IN ('app_start', 'hubspot_initiated'));

-- Phase 2's `lead_pii_purged` left out company_name and job_title, which a privacy deletion purges too
-- (PLAN Phase 3.4). Replace it with the full list, in one transaction with the rest of this migration.
ALTER TABLE "lead" DROP CONSTRAINT "lead_pii_purged";
ALTER TABLE "lead" ADD CONSTRAINT "lead_pii_purged"
  CHECK ("pii_purged_at" IS NULL OR ("email" IS NULL AND "first_name" IS NULL AND "last_name" IS NULL
    AND "phone" IS NULL AND "company_name" IS NULL AND "job_title" IS NULL AND "message" IS NULL
    AND "submission" IS NULL));
