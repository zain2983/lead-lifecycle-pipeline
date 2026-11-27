import path from "node:path";
import { defineConfig, env } from "prisma/config";

// Prisma CLI only (generate, validate, migrate). It uses the session pooler (DIRECT_URL); the app runtime
// uses DATABASE_URL through the pg adapter instead. CI sets both variables. Locally they come from the
// repo-root .env. Docs: https://www.prisma.io/docs/orm/v7/ (pinned to 7.10.1).
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  // No .env file (CI, Vercel): the variables come from the environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DIRECT_URL") },
});
