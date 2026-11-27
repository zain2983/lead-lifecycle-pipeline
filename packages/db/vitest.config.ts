import { loadRootEnvFile } from "@repo/core/dotenv";
import { defineConfig } from "vitest/config";

// The constraint tests run against a real, migrated Postgres: the local one (`pnpm db:up`, URL from the
// repo-root .env) or CI's service container (ci.yml runs `pnpm db:deploy` before `pnpm test`).
loadRootEnvFile(import.meta.dirname);

export default defineConfig({
  test: { testTimeout: 20_000 },
});
