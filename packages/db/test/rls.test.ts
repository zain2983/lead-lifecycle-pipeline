import { loadEnv } from "@repo/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Supabase's Data API serves every table in `public` to its `anon` and `authenticated` roles unless the table
// has row-level security (migration 20261128161500_enable_rls_public). A new table must enable it too.

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: loadEnv(["database"]).DATABASE_URL, max: 1 });
});
afterAll(async () => {
  await pool.end();
});

describe("row-level security", () => {
  it("is enabled on every table in public, including Prisma's own", async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.map((r) => r.relname)).toContain("_prisma_migrations");
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("doesn't hide rows from the owner the app connects as", async () => {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT bool_and(pg_get_userbyid(c.relowner) = current_user AND NOT c.relforcerowsecurity) AS ok
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    expect(rows[0]?.ok).toBe(true);
  });
});
