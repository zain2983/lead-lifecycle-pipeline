import { createPrismaClient, type PrismaClient } from "@repo/db";
import type { OAuthTokenStore } from "./oauth.ts";

// One client per server process. Phase 3 should share this with the queue code's client (Spike A).
let client: PrismaClient | undefined;

/** Upserts by portal ID: reinstalling the app replaces that portal's refresh token. */
export function prismaTokenStore(databaseUrl: string): OAuthTokenStore {
  client ??= createPrismaClient(databaseUrl);
  const db = client;
  return {
    async save(token) {
      const fields = {
        refreshTokenCiphertext: bytes(token.refreshToken.ciphertext),
        refreshTokenIv: bytes(token.refreshToken.iv),
        refreshTokenAuthTag: bytes(token.refreshToken.authTag),
        scopes: token.scopes,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
      };
      await db.oAuthToken.upsert({
        where: { portalId: token.portalId },
        create: { portalId: token.portalId, ...fields },
        update: fields,
      });
    },
  };
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
