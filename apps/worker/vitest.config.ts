import { loadRootEnvFile } from "@repo/core/dotenv";
import { defineConfig } from "vitest/config";

// triage.test.ts uses the real, migrated Postgres: the local one (`pnpm db:up`, URL from the repo-root
// .env) or CI's service container.
loadRootEnvFile(import.meta.dirname);

export default defineConfig({ test: { testTimeout: 20_000 } });
