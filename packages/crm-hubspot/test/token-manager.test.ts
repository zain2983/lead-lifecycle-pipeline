import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getContactById } from "../src/contact-read.ts";
import { HubSpotOAuthError } from "../src/oauth.ts";
import { startFakeHubSpot } from "../src/testing/fake-hubspot.ts";
import { startFakeTokenServer, syntheticTokenResponse } from "../src/testing/fake-token-server.ts";
import { decryptSecret, encryptSecret, refreshTokenAad } from "../src/token-crypto.ts";
import { HubSpotNotInstalledError, HubSpotTokenManager } from "../src/token-manager.ts";
import type {
  OAuthTokenStore,
  RefreshFailure,
  RefreshRecord,
  StoredOAuthToken,
} from "../src/token-store.ts";

const portalId = 900000001n;
const key = randomBytes(32);
const firstRefresh = "na1-0000-synthetic-refresh-token-0001";

/** An in-memory `oauth_token` table. */
function memoryStore(refreshToken: string | null = firstRefresh) {
  const rows = new Map<bigint, StoredOAuthToken>();
  if (refreshToken) {
    rows.set(portalId, {
      portalId,
      refreshToken: encryptSecret(refreshToken, key, refreshTokenAad(portalId)),
      scopes: ["oauth"],
      accessTokenExpiresAt: null,
    });
  }
  const refreshes: RefreshRecord[] = [];
  const failures: RefreshFailure[] = [];
  const store: OAuthTokenStore = {
    async save(token) {
      rows.set(token.portalId, token);
    },
    async load(id) {
      return rows.get(id) ?? null;
    },
    async recordRefresh(id, record) {
      refreshes.push(record);
      const row = rows.get(id);
      if (row && record.rotatedRefreshToken) row.refreshToken = record.rotatedRefreshToken;
    },
    async recordRefreshFailure(_id, failure) {
      failures.push(failure);
    },
  };
  const storedRefreshToken = () => {
    const row = rows.get(portalId);
    return row ? decryptSecret(row.refreshToken, key, refreshTokenAad(portalId)) : null;
  };
  return { store, refreshes, failures, storedRefreshToken };
}

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

/** A token endpoint that issues access-token-1, -2, … and echoes the refresh token it was sent. */
async function tokenServer(overrides: (n: number) => Record<string, unknown> = () => ({})) {
  let issued = 0;
  const server = await startFakeTokenServer((request) => {
    issued++;
    return {
      status: 200,
      body: syntheticTokenResponse({
        access_token: `access-token-${issued}`,
        refresh_token: request.form.get("refresh_token"),
        ...overrides(issued),
      }),
    };
  });
  closers.push(server.close);
  return server;
}

function manager(
  tokenUrl: string,
  store: OAuthTokenStore,
  clock: { now: number },
  extra: Partial<ConstructorParameters<typeof HubSpotTokenManager>[0]> = {},
) {
  return new HubSpotTokenManager({
    clientId: "client-0001",
    clientSecret: "client-secret-0001",
    tokenUrl,
    encryptionKey: key,
    store,
    now: () => new Date(clock.now),
    ...extra,
  });
}

describe("HubSpotTokenManager", () => {
  it("refreshes with the documented grant, then serves the cached token until the safety margin", async () => {
    const server = await tokenServer();
    const { store, refreshes } = memoryStore();
    const clock = { now: Date.parse("2026-11-28T10:00:00Z") };
    const tokens = manager(server.url, store, clock);

    expect(await tokens.getAccessToken(portalId)).toBe("access-token-1");
    const form = server.requests[0]?.form;
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: "refresh_token",
      client_id: "client-0001",
      client_secret: "client-secret-0001",
      refresh_token: firstRefresh,
    });
    expect(refreshes[0]?.accessTokenExpiresAt.toISOString()).toBe("2026-11-28T10:30:00.000Z");

    clock.now += 24 * 60_000; // 24 min: still more than 5 min left
    expect(await tokens.getAccessToken(portalId)).toBe("access-token-1");
    clock.now += 60_000 + 1; // 4 min 59 s left: inside the margin
    expect(await tokens.getAccessToken(portalId)).toBe("access-token-2");
    expect(server.requests).toHaveLength(2);
    expect(tokens.stats).toEqual({ refreshes: 2, cacheHits: 1 });
  });

  it("caps the margin at half the lifetime, so a short-lived token isn't refreshed on every call", async () => {
    const server = await tokenServer(() => ({ expires_in: 240 })); // 4 min < the 5 min margin
    const clock = { now: 0 };
    const tokens = manager(server.url, memoryStore().store, clock);
    await tokens.getAccessToken(portalId);
    clock.now += 119_000;
    await tokens.getAccessToken(portalId);
    expect(server.requests).toHaveLength(1);
    clock.now += 2_000;
    await tokens.getAccessToken(portalId);
    expect(server.requests).toHaveLength(2);
  });

  it("is single-flight per portal: ten concurrent callers share one refresh", async () => {
    const server = await tokenServer();
    const tokens = manager(server.url, memoryStore().store, { now: 0 });
    const all = await Promise.all(
      Array.from({ length: 10 }, () => tokens.getAccessToken(portalId)),
    );
    expect(new Set(all)).toEqual(new Set(["access-token-1"]));
    expect(server.requests).toHaveLength(1);
  });

  it("stores a new refresh token, encrypted, when HubSpot returns one", async () => {
    const server = await tokenServer(() => ({ refresh_token: "na1-0000-rotated-refresh-0002" }));
    const { store, refreshes, storedRefreshToken } = memoryStore();
    const tokens = manager(server.url, store, { now: 0 });
    await tokens.getAccessToken(portalId);
    expect(refreshes[0]?.rotatedRefreshToken).toBeDefined();
    expect(
      Buffer.from(refreshes[0]?.rotatedRefreshToken?.ciphertext ?? []).toString(),
    ).not.toContain("rotated");
    expect(storedRefreshToken()).toBe("na1-0000-rotated-refresh-0002");
    // The same token back again is not a rotation.
    const echo = await tokenServer();
    const { store: store2, refreshes: refreshes2 } = memoryStore();
    await manager(echo.url, store2, { now: 0 }).getAccessToken(portalId);
    expect(refreshes2[0]?.rotatedRefreshToken).toBeUndefined();
  });

  it("a timeout is unknown: nothing cached, recorded as unknown, the next call asks again", async () => {
    let hang = true;
    const server = await startFakeTokenServer(() =>
      hang
        ? "hang"
        : { status: 200, body: syntheticTokenResponse({ refresh_token: firstRefresh }) },
    );
    closers.push(server.close);
    const { store, refreshes, failures } = memoryStore();
    const tokens = manager(server.url, store, { now: 0 }, { timeoutMs: 100 });

    const error = await tokens.getAccessToken(portalId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HubSpotOAuthError);
    expect((error as HubSpotOAuthError).kind).toBe("unknown");
    expect(refreshes).toHaveLength(0);
    expect(failures).toEqual([
      { at: new Date(0), kind: "unknown", message: "token request got no response" },
    ]);

    hang = false;
    expect(await tokens.getAccessToken(portalId)).toBe("synthetic-access-token-0001");
    expect(server.requests).toHaveLength(2);
  });

  it("a revoked refresh token is rejected, with HubSpot's codes recorded and no token", async () => {
    const server = await startFakeTokenServer(() => ({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "refresh token is invalid, expired or revoked",
        status: "BAD_REFRESH_TOKEN",
        message: "refresh token is invalid, expired or revoked",
      },
    }));
    closers.push(server.close);
    const { store, failures } = memoryStore();
    const error = await manager(server.url, store, { now: 0 })
      .getAccessToken(portalId)
      .catch((caught: unknown) => caught);
    expect((error as HubSpotOAuthError).kind).toBe("rejected");
    expect(failures[0]).toMatchObject({
      kind: "rejected",
      status: 400,
      hubspotStatus: "BAD_REFRESH_TOKEN",
      error: "invalid_grant",
    });
    expect(JSON.stringify(failures)).not.toContain(firstRefresh);
  });

  it("refuses an answer for another portal, and a portal with no install", async () => {
    const server = await tokenServer(() => ({ hub_id: 900000002 }));
    const { store, refreshes } = memoryStore();
    await expect(manager(server.url, store, { now: 0 }).getAccessToken(portalId)).rejects.toThrow(
      "answered for portal 900000002",
    );
    expect(refreshes).toHaveLength(0);
    await expect(
      manager(server.url, memoryStore(null).store, { now: 0 }).getAccessToken(portalId),
    ).rejects.toBeInstanceOf(HubSpotNotInstalledError);
  });
});

describe("HubSpotClient with OAuth", () => {
  it("reads a contact with the portal's access token, and retries a 401 once with a fresh one", async () => {
    const server = await tokenServer();
    let valid = "access-token-1";
    const hubspot = await startFakeHubSpot({
      token: "unused-service-key",
      acceptToken: (token) => token === valid,
    });
    closers.push(hubspot.close);
    const id = hubspot.mutate.addContact({ email: "oauth.read@example.com", firstname: "Oauth" });
    const tokens = manager(server.url, memoryStore().store, { now: 0 });
    const client = tokens.clientFor(portalId, { baseUrl: hubspot.url });

    expect((await getContactById(client, id))?.properties.firstname).toBe("Oauth");
    expect(hubspot.requests.at(-1)?.bearer).toBe("access-token-1");

    // HubSpot stops accepting the cached token before its expiry (revoked, or clock skew).
    valid = "access-token-2";
    expect((await getContactById(client, id))?.properties.email).toBe("oauth.read@example.com");
    expect(hubspot.requests.slice(-2).map((r) => [r.bearer, r.authorized])).toEqual([
      ["access-token-1", false],
      ["access-token-2", true],
    ]);
    expect(server.requests).toHaveLength(2);

    // A second 401 in a row is HubSpot's answer, not retried again.
    valid = "nothing-matches";
    await expect(getContactById(client, id)).rejects.toMatchObject({ status: 401 });
  });
});
