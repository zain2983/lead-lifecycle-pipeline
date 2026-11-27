import path from "node:path";
import type { NextConfig } from "next";

// Next reads .env files only from apps/web, so load the repo-root .env here (the same pattern as
// packages/db/prisma.config.ts). Variables already set in the environment win. Don't import
// @repo/core/dotenv instead: it made Turbopack trace the whole repo.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // No .env file (CI, Vercel): the variables come from the environment.
}

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ["@repo/core", "@repo/crm-hubspot", "@repo/db", "@repo/queue"],
  serverExternalPackages: ["pg", "pg-boss"],
  typedRoutes: true,
  poweredByHeader: false,
};

export default config;
