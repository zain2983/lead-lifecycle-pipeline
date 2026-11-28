import { describe, expect, it } from "vitest";
import { EnvError, loadEnv } from "../src/env.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const hubspot = {
  HUBSPOT_CLIENT_ID: "id",
  HUBSPOT_CLIENT_SECRET: "secret",
  HUBSPOT_REDIRECT_URI: "http://localhost:3100/api/hubspot/oauth/callback",
  PUBLIC_WEBHOOK_URL: "https://example.test/api/webhooks/hubspot",
  TOKEN_ENCRYPTION_KEY: key,
};

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
        ...hubspot,
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64"),
      }),
    ).toThrowError(/32 bytes/);
    expect(loadEnv(["hubspot"], hubspot).TOKEN_ENCRYPTION_KEY).toBe(key);
  });

  it("lets the webhook receiver start with only the secret and the public URL", () => {
    const env = loadEnv(["hubspotWebhook"], {
      HUBSPOT_CLIENT_SECRET: "secret",
      PUBLIC_WEBHOOK_URL: "https://example.test/api/webhooks/hubspot",
    });
    expect(env.PUBLIC_WEBHOOK_URL).toBe("https://example.test/api/webhooks/hubspot");
    expect(() => loadEnv(["hubspotOAuth"], { HUBSPOT_CLIENT_SECRET: "secret" })).toThrowError(
      /HUBSPOT_REDIRECT_URI/,
    );
  });

  it("defaults the token endpoint to HubSpot's v3 endpoint", () => {
    expect(loadEnv(["hubspotOAuth"], hubspot).HUBSPOT_OAUTH_TOKEN_URL).toBe(
      "https://api.hubapi.com/oauth/v3/token",
    );
  });
});

describe("HubSpot service-key groups", () => {
  it("needs only the chosen account's key", () => {
    expect(loadEnv(["hubspotServiceKeyDemo"], { HUBSPOT_SERVICE_KEY_DEMO: "k" })).toEqual({
      HUBSPOT_SERVICE_KEY_DEMO: "k",
    });
    expect(() =>
      loadEnv(["hubspotServiceKeyEval"], { HUBSPOT_SERVICE_KEY_DEMO: "k" }),
    ).toThrowError(/HUBSPOT_SERVICE_KEY_EVAL/);
  });

  it("defaults the API base URL to HubSpot", () => {
    expect(loadEnv(["hubspotApi"], {}).HUBSPOT_API_BASE_URL).toBe("https://api.hubapi.com");
  });
});

describe("spikes group", () => {
  it("is on only for exactly 1", () => {
    expect(loadEnv(["spikes"], {}).SPIKE_ROUTES).toBe(false);
    expect(loadEnv(["spikes"], { SPIKE_ROUTES: "0" }).SPIKE_ROUTES).toBe(false);
    expect(loadEnv(["spikes"], { SPIKE_ROUTES: "true" }).SPIKE_ROUTES).toBe(false);
    expect(loadEnv(["spikes"], { SPIKE_ROUTES: "1" }).SPIKE_ROUTES).toBe(true);
  });

  it("parses known portal IDs for HubSpot-initiated installs, and rejects anything else", () => {
    expect(loadEnv(["hubspotOAuth"], hubspot).HUBSPOT_KNOWN_PORTAL_IDS).toEqual([]);
    expect(
      loadEnv(["hubspotOAuth"], { ...hubspot, HUBSPOT_KNOWN_PORTAL_IDS: " 900000001, 900000002 " })
        .HUBSPOT_KNOWN_PORTAL_IDS,
    ).toEqual([900000001n, 900000002n]);
    expect(() =>
      loadEnv(["hubspotOAuth"], { ...hubspot, HUBSPOT_KNOWN_PORTAL_IDS: "9000,demo" }),
    ).toThrowError(/not a portal ID: demo/);
  });

  it("gives the worker the refresh credentials without a redirect URI", () => {
    const { HUBSPOT_REDIRECT_URI: _, PUBLIC_WEBHOOK_URL: __, ...refresh } = hubspot;
    expect(loadEnv(["hubspotTokenRefresh"], refresh).HUBSPOT_CLIENT_ID).toBe("id");
  });
});
