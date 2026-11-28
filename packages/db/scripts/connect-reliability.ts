// How often does a fresh connection fail, with and without the connect retry? Opens a new pool per
// connection, runs `SELECT 1` (read-only), and ends it. The two arms alternate, on DATABASE_URL and
// DIRECT_URL in turn. One JSON line per connection; a summary on stderr. No URL or host is printed.
// Evidence: docs/evidence/phase-1/supabase-tls/.
//
//   pnpm --filter @repo/db exec tsx scripts/connect-reliability.ts [--per-arm 250] [--parallel 4]
import { parseArgs } from "node:util";
import { loadEnv } from "@repo/core";
import pg from "pg";
import { createPgPool } from "../src/client.ts";
import { pgConnectionConfig } from "../src/tls.ts";

const { values } = parseArgs({
  options: {
    "per-arm": { type: "string", default: "250" },
    parallel: { type: "string", default: "4" },
  },
});
const urls = { ...loadEnv(["database"]), ...loadEnv(["databaseDirect"]) };
const total = Number(values["per-arm"]) * 2;

// createPgPool warns once per dropped attempt that it retries: count those.
let retried = 0;
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  if (String(args[0]).startsWith("[db] connection dropped")) retried++;
  warn(...args);
};
const results: Array<{ arm: string; ok: boolean }> = [];

async function connection(index: number): Promise<void> {
  const arm = index % 2 === 0 ? "plain pg.Pool" : "createPgPool";
  const variable = index % 4 < 2 ? "DATABASE_URL" : "DIRECT_URL";
  const url = urls[variable];
  const pool =
    arm === "createPgPool"
      ? createPgPool(url, { max: 1, applicationName: `reliability:${index}` })
      : new pg.Pool({ ...pgConnectionConfig(url), max: 1 });
  pool.on("error", () => undefined);
  const started = performance.now();
  let error: { code?: string; message: string } | undefined;
  try {
    await pool.query("SELECT 1");
  } catch (caught) {
    const { code, message } = caught as Error & { code?: string };
    error = { code, message: code?.startsWith("E") ? code : message.slice(0, 80) };
  }
  const ms = Math.round(performance.now() - started);
  await pool.end().catch(() => undefined);
  const row = { index, arm, variable, ok: !error, ms, error };
  console.log(JSON.stringify(row));
  results.push({ arm, ok: !error });
}

let next = 0;
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    while (next < total) await connection(next++);
  }),
);

for (const arm of ["plain pg.Pool", "createPgPool"]) {
  const rows = results.filter((row) => row.arm === arm);
  console.error(`${arm}: ${rows.filter((row) => !row.ok).length} of ${rows.length} failed`);
}
console.error(`createPgPool: ${retried} dropped attempts retried`);
