// No network: what each URL turns into, and what node-postgres makes of the result.
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { SUPABASE_ROOT_CA } from "../src/supabase-ca.ts";
import { pgConnectionConfig, TlsConfigError, tlsRule } from "../src/tls.ts";
import { pgCliUrl, prismaCliUrl, supabaseCaPath } from "../src/tls-cli.ts";

const LOCAL = "postgresql://app:app@localhost:5433/app";
const HOSTED = "postgresql://user.ref:s3cr%40t@region.pooler.supabase.com:6543/postgres";
const VERIFIED = `${HOSTED}?sslmode=verify-full`;

/** The settings node-postgres resolves for a config. Constructing a Client opens no connection. */
function resolved(config: pg.ClientConfig) {
  const client = new pg.Client(config) as pg.Client & {
    connectionParameters: { ssl: unknown; host: string; port: number; password: string };
  };
  // `password` and `ssl.key` are non-enumerable on connectionParameters; read them by name.
  const { ssl, host, port } = client.connectionParameters;
  return { ssl, host, port, password: client.password };
}

describe("the bundled certificate", () => {
  const file = readFileSync(supabaseCaPath(), "utf8");

  it("is the same in the .crt file and in the embedded copy", () => {
    expect(SUPABASE_ROOT_CA.trim()).toBe(file.trim());
    expect(file.match(/BEGIN CERTIFICATE/g)).toHaveLength(1);
  });

  it("is Supabase's root CA, by fingerprint", () => {
    const certificate = new X509Certificate(file);
    expect(certificate.fingerprint256).toBe(
      "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
    );
    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toContain("CN=Supabase Root 2021 CA");
  });
});

describe("a local URL stays plain", () => {
  it.each([
    LOCAL,
    `${LOCAL}?sslmode=disable`,
    "postgresql://app:app@postgres:5432/app?pgbouncer=true",
    "postgresql://app@/app?host=/var/run/postgresql",
    "postgresql://app:app@supabase.com.example.org:5432/app",
    "postgresql://app:app@notsupabase.com:5432/app",
  ])("%s", (url) => {
    expect(pgConnectionConfig(url)).toEqual({ connectionString: url });
    expect(pgCliUrl(url)).toBe(url);
    expect(prismaCliUrl(url)).toBe(url);
  });

  it("opens no TLS", () => {
    expect(resolved(pgConnectionConfig(LOCAL)).ssl).toBe(false);
  });
});

describe("a Supabase URL without sslmode=verify-full is refused", () => {
  it.each([
    HOSTED,
    `${HOSTED}?sslmode=require`,
    `${HOSTED}?sslmode=no-verify`,
    `${HOSTED}?sslmode=disable`,
    `${HOSTED}?uselibpqcompat=true&sslmode=require`,
    `${HOSTED}?ssl=true`,
    `${HOSTED}?sslmode=verify-full&sslmode=disable`,
    "postgresql://u:p@db.ref.supabase.co:5432/postgres",
    "postgresql://u:p@REGION.POOLER.SUPABASE.COM.:5432/postgres",
    "postgresql://u:p@localhost:5432/postgres?host=region.pooler.supabase.com",
  ])("%s", (url) => {
    for (const convert of [pgConnectionConfig, pgCliUrl, prismaCliUrl]) {
      expect(() => convert(url)).toThrow(TlsConfigError);
    }
  });

  it("never puts the URL in the error", () => {
    for (const url of [HOSTED, "postgresql://user:hunter2@[bad/db"]) {
      let message = "";
      try {
        tlsRule(url);
      } catch (error) {
        message = `${(error as Error).message} ${JSON.stringify(error)}`;
      }
      expect(message).not.toBe("");
      expect(message).not.toMatch(/s3cr|hunter2|pooler|user\.ref/);
    }
  });
});

describe("sslmode=verify-full on a Supabase host", () => {
  it("gives node-postgres the bundled CA, and no URL parameter can replace it", () => {
    const config = pgConnectionConfig(
      `${VERIFIED}&ssl=0&sslnegotiation=direct&uselibpqcompat=true&application_name=x`,
    );
    expect(config.connectionString).toBe(`${HOSTED}?application_name=x`);
    expect(resolved(config)).toEqual({
      ssl: { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true },
      host: "region.pooler.supabase.com",
      port: 6543,
      password: "s3cr@t",
    });
  });

  it("gives the pg-boss CLI the CA file, which node-postgres reads and verifies against", () => {
    const url = pgCliUrl(VERIFIED);
    expect(new URL(url).searchParams.get("sslrootcert")).toBe(supabaseCaPath());
    // An `ssl` object with a CA and nothing that turns verification off.
    expect(resolved({ connectionString: url })).toMatchObject({
      ssl: { ca: readFileSync(supabaseCaPath(), "utf8") },
      password: "s3cr@t",
    });
    expect(resolved({ connectionString: url }).ssl).not.toHaveProperty("rejectUnauthorized");
  });

  it("gives the Prisma CLI the schema engine's parameters", () => {
    const url = new URL(prismaCliUrl(`${VERIFIED}&sslaccept=accept_invalid_certs`));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      sslmode: "require",
      sslaccept: "strict",
      sslcert: supabaseCaPath(),
    });
    expect(url.password).toBe("s3cr%40t");
  });
});

describe("sslmode=verify-full with the URL's own CA, or on another host", () => {
  const own = `${VERIFIED}&sslrootcert=/tmp/other-ca.crt`;

  it("leaves node-postgres to read the URL's sslrootcert", () => {
    expect(pgConnectionConfig(own)).toEqual({ connectionString: own });
    expect(pgCliUrl(own)).toBe(own);
  });

  it("moves that CA to sslcert for the Prisma CLI", () => {
    const { searchParams } = new URL(prismaCliUrl(own));
    expect(searchParams.get("sslcert")).toBe("/tmp/other-ca.crt");
    expect(searchParams.get("sslaccept")).toBe("strict");
    expect(searchParams.has("sslrootcert")).toBe(false);
  });

  it("uses the system's CAs on another host, strictly for the Prisma CLI too", () => {
    const url = "postgresql://u:p@db.example.com:5432/app?sslmode=verify-full";
    expect(pgConnectionConfig(url)).toEqual({ connectionString: url });
    const { searchParams } = new URL(prismaCliUrl(url));
    expect(Object.fromEntries(searchParams)).toEqual({ sslmode: "require", sslaccept: "strict" });
  });
});
