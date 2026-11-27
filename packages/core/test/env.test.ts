import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/env.ts";

const key = Buffer.alloc(32, 7).toString("base64");

describe("loadEnv", () => {
  it("returns typed values for the requested groups", () => {
    const env = loadEnv(["database", "app"], {
      DATABASE_URL: "postgresql://app:app@localhost:5433/app",
      PUBLIC_BASE_URL: "http://localhost:3100",
    });
    expect(env.DATABASE_URL).toBe("postgresql://app:app@localhost:5433/app");
    expect(env.NODE_ENV).toBe("development");
  });

  it("lists every missing variable at once", () => {
    expect(() => loadEnv(["database", "hubspot"], {})).toThrowError(EnvError);
    try {
      loadEnv(["database", "hubspot"], {});
    } catch (error) {
      const message = (error as Error).message;
      for (const name of ["DATABASE_URL", "HUBSPOT_CLIENT_ID", "PUBLIC_WEBHOOK_URL"]) {
        expect(message).toContain(name);
      }
    }
  });

  it("rejects an encryption key that is not 32 bytes", () => {
    expect(() =>
      loadEnv(["hubspot"], {
        HUBSPOT_CLIENT_ID: "id",
        HUBSPOT_CLIENT_SECRET: "secret",
        PUBLIC_WEBHOOK_URL: "https://example.test/api/webhooks/hubspot",
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrowError(/32 bytes/);
    expect(
      loadEnv(["hubspot"], {
        HUBSPOT_CLIENT_ID: "id",
        HUBSPOT_CLIENT_SECRET: "secret",
        PUBLIC_WEBHOOK_URL: "https://example.test/api/webhooks/hubspot",
        TOKEN_ENCRYPTION_KEY: key,
      }).TOKEN_ENCRYPTION_KEY,
    ).toBe(key);
  });
});
