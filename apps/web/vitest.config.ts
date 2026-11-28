import { loadRootEnvFile } from "@repo/core/dotenv";
import { defineConfig } from "vitest/config";

// The intake tests use a real, migrated Postgres: the local one (`pnpm db:up`, URL from the repo-root
// .env) or CI's service container. The other tests are offline.
loadRootEnvFile(import.meta.dirname);

export default defineConfig({
  test: {
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
    globalSetup: ["./test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
