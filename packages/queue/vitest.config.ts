import { loadRootEnvFile } from "@repo/core/dotenv";
import { defineConfig } from "vitest/config";

// Tests run against a real Postgres: the local one (`pnpm db:up`, URL from the repo-root .env) or CI's
// service container (DATABASE_URL and DIRECT_URL set by ci.yml).
loadRootEnvFile(import.meta.dirname);

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
