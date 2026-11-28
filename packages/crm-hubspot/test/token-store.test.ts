import { randomBytes } from "node:crypto";
import { loadEnv } from "@repo/core";
import { createPrismaClient, type PrismaClient } from "@repo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, refreshTokenAad } from "../src/token-crypto.ts";
import { prismaOAuthTokenStore } from "../src/token-store.ts";

// A portal ID no fixture or other test uses; removed afterwards.
const portalId = 900000777n;
const key = randomBytes(32);
const aad = refreshTokenAad(portalId);
let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createPrismaClient(loadEnv(["database"]).DATABASE_URL);
  await prisma.oAuthToken.deleteMany({ where: { portalId } });
});
afterAll(async () => {
  await prisma?.oAuthToken.deleteMany({ where: { portalId } });
  await prisma?.$disconnect();
});

describe("prismaOAuthTokenStore (oauth_token)", () => {
  it("saves, loads, records refreshes and failures, and a reinstall clears the bookkeeping", async () => {
    const store = prismaOAuthTokenStore(prisma);
    await store.save({
      portalId,
      refreshToken: encryptSecret("na1-first", key, aad),
      scopes: ["oauth"],
      accessTokenExpiresAt: null,
      installedVia: "hubspot_initiated",
    });
    const loaded = await store.load(portalId);
    expect(loaded?.installedVia).toBe("hubspot_initiated");
    expect(
      decryptSecret(
        loaded?.refreshToken ?? {
          ciphertext: new Uint8Array(),
          iv: new Uint8Array(),
          authTag: new Uint8Array(),
        },
        key,
        aad,
      ),
    ).toBe("na1-first");
    expect(await store.load(900000778n)).toBeNull();

    const at = new Date("2026-11-28T10:00:00.000Z");
    await store.recordRefreshFailure(portalId, {
      at,
      kind: "unknown",
      message: "token request got no response",
    });
    let row = await prisma.oAuthToken.findUniqueOrThrow({ where: { portalId } });
    expect(row.lastRefreshError).toEqual({
      kind: "unknown",
      message: "token request got no response",
    });
    expect(row.lastRefreshErrorAt?.toISOString()).toBe(at.toISOString());

    await store.recordRefresh(portalId, {
      at,
      accessTokenExpiresAt: new Date("2026-11-28T10:30:00.000Z"),
      scopes: ["oauth", "crm.objects.contacts.read"],
      rotatedRefreshToken: encryptSecret("na1-second", key, aad),
    });
    row = await prisma.oAuthToken.findUniqueOrThrow({ where: { portalId } });
    expect(row.lastRefreshError).toBeNull();
    expect(row.lastRefreshedAt?.toISOString()).toBe(at.toISOString());
    expect(row.refreshTokenRotatedAt?.toISOString()).toBe(at.toISOString());
    expect(row.scopes).toEqual(["oauth", "crm.objects.contacts.read"]);
    const reloaded = await store.load(portalId);
    if (!reloaded) throw new Error("row vanished");
    expect(decryptSecret(reloaded.refreshToken, key, aad)).toBe("na1-second");

    await store.save({
      portalId,
      refreshToken: encryptSecret("na1-reinstall", key, aad),
      scopes: ["oauth"],
      accessTokenExpiresAt: null,
    });
    row = await prisma.oAuthToken.findUniqueOrThrow({ where: { portalId } });
    expect([row.installedVia, row.lastRefreshedAt, row.refreshTokenRotatedAt]).toEqual([
      "app_start",
      null,
      null,
    ]);
  });
});
