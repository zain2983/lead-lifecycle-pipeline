// `SELECT 1` (and one LISTEN) over every node-postgres path the app has, against DATABASE_URL and
// DIRECT_URL: createPgPool, createPrismaClient and createBoss. Read-only: pg-boss isn't started, only its
// database layer is opened. With `--negative <wrong-ca.crt>` it also runs the URLs that must fail.
// Prints codes and booleans, never a URL. Evidence: docs/evidence/phase-1/supabase-tls/.
//
//   NODE_OPTIONS="--require $PWD/docs/evidence/phase-1/supabase-tls/tls-observer.cjs" \
//     pnpm --filter @repo/queue exec tsx src/spikes/tls-probe.ts
import { lookup } from "node:dns/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "@repo/core";
import { createPgPool, createPrismaClient } from "@repo/db";
import { supabaseCaPath } from "@repo/db/tls-cli";
import { createBoss } from "../boss.ts";

const { values } = parseArgs({ options: { negative: { type: "string" } } });
const { DATABASE_URL, DIRECT_URL } = { ...loadEnv(["database"]), ...loadEnv(["databaseDirect"]) };

/** pg-boss's own database layer, as createBoss configured it. start() would also run its checks. */
interface BossDb {
  open(): Promise<void>;
  close(): Promise<void>;
  executeSql(text: string): Promise<unknown>;
  listen(channel: string, onMessage: () => void, onReconnect: () => void): Promise<unknown>;
}

const paths: Record<string, (url: string) => Promise<void>> = {
  createPgPool: async (url) => {
    const pool = createPgPool(url, { max: 1 });
    try {
      await pool.query("SELECT 1");
    } finally {
      await pool.end();
    }
  },
  createPrismaClient: async (url) => {
    const prisma = createPrismaClient(url);
    try {
      await prisma.$queryRaw`SELECT 1`;
    } finally {
      await prisma.$disconnect();
    }
  },
  "createBoss: pg-boss pool": async (url) => {
    const db = createBoss({ mode: "worker", connectionString: url }).getDb() as unknown as BossDb;
    await db.open();
    try {
      await db.executeSql("SELECT 1");
    } finally {
      await db.close();
    }
  },
  "createBoss: pg-boss LISTEN client": async (url) => {
    const db = createBoss({ mode: "worker", connectionString: url }).getDb() as unknown as BossDb;
    await db.open();
    try {
      const listener = (await db.listen(
        "spike_tls_probe",
        () => undefined,
        () => undefined,
      )) as { close(): Promise<void> };
      await listener.close();
    } finally {
      await db.close();
    }
  },
};

async function probe(variable: string, variant: string, url: string): Promise<void> {
  for (const [name, run] of Object.entries(paths)) {
    process.stderr.write(`--- ${variable} | ${variant} | ${name}\n`);
    try {
      await run(url);
      process.stderr.write("result: ok\n");
    } catch (error) {
      const { name: type, code, message } = error as Error & { code?: string };
      // Only the config error's text is safe to print: others can name the host.
      const detail = type === "TlsConfigError" ? message : (code ?? type);
      process.stderr.write(`result: failed: ${detail}\n`);
    }
  }
}

for (const [variable, url] of Object.entries({ DATABASE_URL, DIRECT_URL })) {
  await probe(variable, "as configured", url);
  if (!values.negative) continue;
  const bare = new URL(url);
  bare.search = "";
  await probe(variable, "no sslmode", bare.toString());
  const wrongCa = new URL(url);
  wrongCa.searchParams.set("sslrootcert", path.resolve(values.negative));
  await probe(variable, "unrelated CA", wrongCa.toString());
  const byAddress = new URL(url);
  byAddress.searchParams.set("sslrootcert", supabaseCaPath());
  byAddress.hostname = (await lookup(byAddress.hostname, { family: 4 })).address;
  await probe(variable, "right CA, wrong host name (IP address)", byAddress.toString());
}
