import { createPrismaClient, type PrismaClient } from "@repo/db";
import type { OAuthTokenStore } from "./oauth.ts";

// One client per server process, owned by this file for now. Phase 3 moves it to a shared
// apps/web/lib/db.ts (Spike A added no shared web client: its route keeps its own pools).
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
