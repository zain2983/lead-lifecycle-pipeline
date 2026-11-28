// A TCP proxy in front of the local Postgres (`pnpm db:up`, or CI's service) drops the first N connections
// the way Supabase's path was seen to: closed, or reset, after the client's first bytes.
import net from "node:net";
import { loadEnv } from "@repo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPgPool, createPrismaClient } from "../src/client.ts";
import { isTransientConnectError } from "../src/retry-pool.ts";

const database = new URL(loadEnv(["database"]).DATABASE_URL);
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function flakyProxy(drops: number, how: "close" | "reset" = "close") {
  const seen = { connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    seen.connections++;
    if (seen.connections <= drops) {
      client.once("data", () => (how === "reset" ? client.resetAndDestroy() : client.end()));
      return;
    }
    const upstream = net.connect(Number(database.port || 5432), database.hostname);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const url = new URL(database);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as net.AddressInfo).port);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  return { url: url.toString(), seen };
}

function pool(url: string) {
  const created = createPgPool(url, { max: 1 });
  cleanups.push(() => created.end());
  return created;
}

describe("a connection dropped during setup", () => {
  it.each(["close", "reset"] as const)("is retried for pool.query (%s)", async (how) => {
    const { url, seen } = await flakyProxy(2, how);
    const { rows } = await pool(url).query("SELECT 1 AS n");
    expect(rows).toEqual([{ n: 1 }]);
    expect(seen.connections).toBe(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("is retried for pool.connect, and the client can be released and reused", async () => {
    const { url, seen } = await flakyProxy(1);
    const created = pool(url);
    const client = await created.connect();
    await client.query("SELECT 1");
    client.release();
    await created.query("SELECT 1");
    expect(seen.connections).toBe(2);
    expect(created.totalCount).toBe(1);
  });

  it("is retried for a Prisma client made from a URL, including a transaction", async () => {
    const { url, seen } = await flakyProxy(1);
    const prisma = createPrismaClient(url);
    cleanups.push(() => prisma.$disconnect());
    const rows = await prisma.$transaction((tx) => tx.$queryRaw`SELECT 1 AS n`);
    expect(rows).toEqual([{ n: 1 }]);
    expect(seen.connections).toBe(2);
  });

  it("fails after three attempts, with the driver's error", async () => {
    const { url, seen } = await flakyProxy(Number.POSITIVE_INFINITY);
    const created = pool(url);
    await expect(created.query("SELECT 1")).rejects.toThrow("Connection terminated unexpectedly");
    expect(seen.connections).toBe(3);
    expect(created.totalCount).toBe(0);
  });
});

describe("what is not retried", () => {
  it("a statement that loses its open connection", async () => {
    const { url, seen } = await flakyProxy(0);
    const created = pool(url);
    created.on("error", () => undefined);
    await expect(created.query("SELECT pg_terminate_backend(pg_backend_pid())")).rejects.toThrow();
    expect(seen.connections).toBe(1);
  });

  it("the server's own refusal", async () => {
    const { url, seen } = await flakyProxy(0);
    const missing = new URL(url);
    missing.pathname = "/no_such_database";
    await expect(pool(missing.toString()).query("SELECT 1")).rejects.toMatchObject({
      code: "3D000",
    });
    expect(seen.connections).toBe(1);
  });

  it.each([
    Object.assign(new Error("self-signed certificate"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    Object.assign(new Error("password authentication failed"), { code: "28P01" }),
    Object.assign(new Error("too many clients"), { code: "53300" }),
    Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    new Error("timeout exceeded when trying to connect"),
  ])("$message", (error) => {
    expect(isTransientConnectError(error)).toBe(false);
  });
});
