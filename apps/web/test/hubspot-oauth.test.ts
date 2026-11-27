import { randomBytes } from "node:crypto";
import { decryptSecret, refreshTokenAad } from "@repo/crm-hubspot";
import { startFakeTokenServer, syntheticTokenResponse } from "@repo/crm-hubspot/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeHubSpotOAuth,
  OAUTH_STATE_COOKIE,
  type StoredOAuthToken,
  startHubSpotOAuth,
} from "../lib/hubspot/oauth.ts";

const redirectUri = "http://localhost:3100/api/hubspot/oauth/callback";
const clientId = "client-0001";
const state = "synthetic-state-0001";
const encryptionKey = randomBytes(32);

describe("GET /api/hubspot/oauth/start", () => {
  it("sets a one-time state cookie and redirects to HubSpot's authorize URL", () => {
    const response = startHubSpotOAuth({ clientId, redirectUri, state });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://app.hubspot.com/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(location.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("scope")).toContain("crm.objects.deals.write");
    expect(response.headers.get("set-cookie")).toBe(
      `${OAUTH_STATE_COOKIE}=${state}; Path=/api/hubspot/oauth; Max-Age=600; HttpOnly; SameSite=Lax`,
    );
  });

  it("generates a random state, and marks the cookie Secure on https", () => {
    const a = startHubSpotOAuth({ clientId, redirectUri: "https://web.example.test/cb" });
    const b = startHubSpotOAuth({ clientId, redirectUri: "https://web.example.test/cb" });
    const stateOf = (r: Response) =>
      new URL(r.headers.get("location") ?? "").searchParams.get("state");
    expect(stateOf(a)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateOf(a)).not.toBe(stateOf(b));
    expect(a.headers.get("set-cookie")).toContain("; Secure");
  });
});

describe("GET /api/hubspot/oauth/callback (fake token endpoint)", () => {
  let saved: StoredOAuthToken[];
  let server: Awaited<ReturnType<typeof startFakeTokenServer>> | undefined;

  beforeEach(() => {
    saved = [];
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
  });

  const callback = (query: string, cookie: string | null = `${OAUTH_STATE_COOKIE}=${state}`) =>
    new Request(`${redirectUri}?${query}`, { headers: cookie ? { cookie } : {} });

  const config = (tokenUrl: string) => ({
    clientId,
    clientSecret: "client-secret-0001",
    redirectUri,
    tokenUrl,
    encryptionKey,
    store: { save: async (token: StoredOAuthToken) => void saved.push(token) },
    now: () => new Date("2026-11-27T15:00:00.000Z"),
  });

  it("exchanges the code and stores only the encrypted refresh token", async () => {
    const tokens = syntheticTokenResponse();
    server = await startFakeTokenServer(() => ({ status: 200, body: tokens }));
    const response = await completeHubSpotOAuth(
      callback(
        `code=synthetic-code-0001&state=${state}`,
        `other=1; ${OAUTH_STATE_COOKIE}=${state}`,
      ),
      config(server.url),
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      portalId: "900000001",
      scopes: tokens.scopes,
      accessTokenExpiresAt: "2026-11-27T15:30:00.000Z",
    });
    expect(text).not.toContain(tokens.refresh_token);
    expect(text).not.toContain(tokens.access_token);
    expect(response.headers.get("set-cookie")).toContain(
      `${OAUTH_STATE_COOKIE}=; Path=/api/hubspot/oauth; Max-Age=0`,
    );

    expect(server.requests[0]?.form.get("code")).toBe("synthetic-code-0001");
    expect(server.requests[0]?.form.get("redirect_uri")).toBe(redirectUri);
    expect(saved).toHaveLength(1);
    const row = saved[0];
    if (!row) throw new Error("no token saved");
    expect(row.portalId).toBe(900000001n);
    expect(Buffer.from(row.refreshToken.ciphertext).toString("utf8")).not.toContain("refresh");
    expect(decryptSecret(row.refreshToken, encryptionKey, refreshTokenAad(900000001n))).toBe(
      tokens.refresh_token,
    );
  });

  it("rejects a state that doesn't match the cookie, without calling the token endpoint", async () => {
    server = await startFakeTokenServer(() => ({ status: 200, body: syntheticTokenResponse() }));
    const response = await completeHubSpotOAuth(
      callback("code=synthetic-code-0001&state=forged-state"),
      config(server.url),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "state_mismatch" });
    expect(server.requests).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it("rejects a callback without the state cookie", async () => {
    server = await startFakeTokenServer(() => ({ status: 200, body: syntheticTokenResponse() }));
    const response = await completeHubSpotOAuth(
      callback(`code=synthetic-code-0001&state=${state}`, null),
      config(server.url),
    );
    expect(await response.json()).toEqual({ ok: false, error: "state_missing" });
    expect(server.requests).toHaveLength(0);
  });

  it("passes on HubSpot's error from the token endpoint as it came back", async () => {
    const errorBody = { status: "BAD_AUTH_CODE", message: "missing or unknown auth code" };
    server = await startFakeTokenServer(() => ({ status: 400, body: errorBody }));
    const response = await completeHubSpotOAuth(
      callback(`code=used-code&state=${state}`),
      config(server.url),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "token_exchange_failed",
      detail: "token endpoint answered 400",
      status: 400,
      hubspot: errorBody,
    });
    expect(saved).toHaveLength(0);
  });

  it("reports a token endpoint that never answers as unknown (504)", async () => {
    server = await startFakeTokenServer(() => "hang");
    const fetchWithShortTimeout: typeof fetch = (input, init) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(200) });
    const response = await completeHubSpotOAuth(callback(`code=c&state=${state}`), {
      ...config(server.url),
      fetch: fetchWithShortTimeout,
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ error: "token_exchange_unknown" });
    expect(saved).toHaveLength(0);
  });

  it("reports an error HubSpot sends back to the redirect URI", async () => {
    server = await startFakeTokenServer(() => ({ status: 200, body: syntheticTokenResponse() }));
    const response = await completeHubSpotOAuth(
      callback(`error=access_denied&error_description=denied&state=${state}`),
      config(server.url),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "authorization_failed",
      hubspot: { error: "access_denied" },
    });
    expect(server.requests).toHaveLength(0);
  });
});
