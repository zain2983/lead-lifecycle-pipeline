import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  HUBSPOT_REQUIRED_SCOPES,
  HubSpotOAuthError,
} from "../src/oauth.ts";
import { startFakeTokenServer, syntheticTokenResponse } from "../src/testing/fake-token-server.ts";

const redirectUri = "http://localhost:3100/api/hubspot/oauth/callback";

describe("buildAuthorizeUrl", () => {
  it("builds HubSpot's authorize URL with %20-separated scopes", () => {
    const url = buildAuthorizeUrl({ clientId: "client-0001", redirectUri, state: "s+t/a=te" });
    expect(
      url.startsWith(
        "https://app.hubspot.com/oauth/authorize?client_id=client-0001&scope=oauth%20crm.objects.contacts.read%20",
      ),
    ).toBe(true);
    expect(url).not.toContain("+");
    const params = new URL(url).searchParams;
    expect(params.get("scope")?.split(" ")).toEqual([...HUBSPOT_REQUIRED_SCOPES]);
    expect(params.get("redirect_uri")).toBe(redirectUri);
    expect(params.get("state")).toBe("s+t/a=te");
  });
});

describe("HUBSPOT_REQUIRED_SCOPES", () => {
  it("matches requiredScopes in the dev app's app-hsmeta.json", () => {
    const file = path.resolve(
      import.meta.dirname,
      "../../../integrations/hubspot-app/dev/src/app/app-hsmeta.json",
    );
    const app = JSON.parse(readFileSync(file, "utf8")) as {
      config: { auth: { requiredScopes: string[]; redirectUrls: string[] } };
    };
    expect(app.config.auth.requiredScopes).toEqual([...HUBSPOT_REQUIRED_SCOPES]);
    expect(app.config.auth.redirectUrls).toContain(redirectUri);
  });
});

describe("exchangeAuthorizationCode (against a fake token endpoint)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const base = {
    code: "synthetic-code-0001",
    clientId: "client-0001",
    clientSecret: "client-secret-0001",
    redirectUri,
  };

  it("posts the documented form fields and returns the tokens", async () => {
    const server = await startFakeTokenServer(() => ({
      status: 200,
      body: syntheticTokenResponse(),
    }));
    close = server.close;
    const now = new Date("2026-11-27T15:00:00.000Z");
    const tokens = await exchangeAuthorizationCode({
      ...base,
      tokenUrl: server.url,
      now: () => now,
    });

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.method).toBe("POST");
    expect(request?.contentType).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(request?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      client_id: "client-0001",
      client_secret: "client-secret-0001",
      redirect_uri: redirectUri,
      code: "synthetic-code-0001",
    });
    expect(tokens).toEqual({
      portalId: 900000001n,
      accessToken: "synthetic-access-token-0001",
      refreshToken: "na1-0000-synthetic-refresh-token-0001",
      accessTokenExpiresAt: new Date("2026-11-27T15:30:00.000Z"),
      scopes: ["oauth", "crm.objects.contacts.read", "crm.objects.contacts.write"],
      tokenType: "bearer",
    });
  });

  it("reports HubSpot's error status and body as they came back", async () => {
    const errorBody = {
      status: "BAD_AUTH_CODE",
      message: "missing or unknown auth code",
      correlationId: "00000000-0000-0000-0000-000000000000",
    };
    const server = await startFakeTokenServer(() => ({ status: 400, body: errorBody }));
    close = server.close;
    const error = await exchangeAuthorizationCode({ ...base, tokenUrl: server.url }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(HubSpotOAuthError);
    expect(error).toMatchObject({ kind: "rejected", status: 400, body: JSON.stringify(errorBody) });
  });

  it("rejects a 200 without hub_id, naming the field but not the token values", async () => {
    const response = syntheticTokenResponse();
    const { hub_id: _drop, ...withoutHubId } = response;
    const server = await startFakeTokenServer(() => ({ status: 200, body: withoutHubId }));
    close = server.close;
    const error = await exchangeAuthorizationCode({ ...base, tokenUrl: server.url }).catch(
      (e) => e,
    );
    expect(error).toMatchObject({ kind: "invalid_response" });
    expect(String(error.message)).toContain("hub_id");
    expect(String(error.message)).not.toContain(response.refresh_token);
  });

  it("treats a timeout as unknown, not as failed", async () => {
    const server = await startFakeTokenServer(() => "hang");
    close = server.close;
    const error = await exchangeAuthorizationCode({
      ...base,
      tokenUrl: server.url,
      timeoutMs: 200,
    }).catch((e) => e);
    expect(error).toMatchObject({ name: "HubSpotOAuthError", kind: "unknown" });
  });
});
