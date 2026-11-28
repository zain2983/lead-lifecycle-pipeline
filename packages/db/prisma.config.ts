import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma CLI only (generate, validate, migrate). It uses the session pooler (DIRECT_URL); the app runtime
// uses DATABASE_URL through the pg adapter instead. CI sets both variables. Locally they come from the
// repo-root .env. Docs: https://www.prisma.io/docs/orm/v7/ (pinned to 7.10.1).
try {
  process.loadEnvFile(path.resolve(process.cwd(), "../../.env"));
} catch {
  // No .env file (CI, Vercel): the variables come from the environment.
}

// Optional on purpose: `prisma generate` needs no database, and the Vercel build has no DIRECT_URL (Prisma's
// `env()` helper throws when it is unset, which failed the first Vercel deploy). Commands that connect
// (`migrate deploy`, `migrate dev`) still fail, with Prisma's own "no datasource URL" error.
const url = process.env.DIRECT_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(url ? { datasource: { url } } : {}),
});
