// `pnpm --filter @repo/queue migrate [--dry-run]` runs `pg-boss migrate`: pg-boss 12's CLI, which creates
// the schema if it's missing and applies pending migrations otherwise. `pnpm --filter @repo/queue pgboss
// <command>` passes any other command through (version, doctor, plans). The connection is DIRECT_URL: the
// session pooler in production, as migrate.yml sets it. Locally it comes from the repo-root .env.
import { loadEnv } from "@repo/core";
import { loadRootEnvFile } from "@repo/core/dotenv";
import { runPgBossCli } from "../pgboss-cli.ts";

loadRootEnvFile();
const { DIRECT_URL } = loadEnv(["databaseDirect"]);
const args = process.argv.slice(2);
process.exitCode = runPgBossCli(args.length > 0 ? args : ["--help"], DIRECT_URL);
