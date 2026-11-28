import { Prisma, type PrismaClient } from "@repo/db";
import type { EncryptedSecret } from "./token-crypto.ts";

/**
 * Where a portal's OAuth install lives (`oauth_token`). It holds the refresh token **encrypted** (see
 * token-crypto.ts) and never the access token, which lives 30 minutes and stays in memory
 * (token-manager.ts). Nothing here encrypts or decrypts: the store moves ciphertext only.
 */

/** `app_start`: began at /api/hubspot/oauth/start (state checked). `hubspot_initiated`: ADR 0006. */
export type InstallSource = "app_start" | "hubspot_initiated";

export interface StoredOAuthToken {
  portalId: bigint;
  refreshToken: EncryptedSecret;
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  installedVia?: InstallSource;
}

export interface RefreshRecord {
  at: Date;
  accessTokenExpiresAt: Date;
  /** Only when HubSpot sent scopes. */
  scopes?: string[];
  /** Only when HubSpot sent a refresh token different from the stored one: it replaces it. */
  rotatedRefreshToken?: EncryptedSecret;
}

/** Never holds a token: HubSpot's status and error codes only. */
export interface RefreshFailure {
  at: Date;
  kind: "rejected" | "invalid_response" | "unknown";
  status?: number;
  /** HubSpot's `status`, e.g. `BAD_REFRESH_TOKEN`. */
  hubspotStatus?: string;
  /** HubSpot's `error`, e.g. `invalid_grant`. */
  error?: string;
  message: string;
}

export interface OAuthTokenStore {
  /** An install: replaces the portal's refresh token and clears its refresh bookkeeping. */
  save(token: StoredOAuthToken): Promise<void>;
  load(portalId: bigint): Promise<StoredOAuthToken | null>;
  recordRefresh(portalId: bigint, record: RefreshRecord): Promise<void>;
  recordRefreshFailure(portalId: bigint, failure: RefreshFailure): Promise<void>;
}

/** The `oauth_token` table through Prisma. Upserts by portal ID: a reinstall replaces the token. */
export function prismaOAuthTokenStore(db: PrismaClient): OAuthTokenStore {
  return {
    async save(token) {
      const fields = {
        refreshTokenCiphertext: bytes(token.refreshToken.ciphertext),
        refreshTokenIv: bytes(token.refreshToken.iv),
        refreshTokenAuthTag: bytes(token.refreshToken.authTag),
        scopes: token.scopes,
        accessTokenExpiresAt: token.accessTokenExpiresAt,
        installedVia: token.installedVia ?? "app_start",
        lastRefreshedAt: null,
        refreshTokenRotatedAt: null,
        lastRefreshError: Prisma.DbNull,
        lastRefreshErrorAt: null,
      };
      await db.oAuthToken.upsert({
        where: { portalId: token.portalId },
        create: { portalId: token.portalId, ...fields },
        update: fields,
      });
    },

    async load(portalId) {
      const row = await db.oAuthToken.findUnique({ where: { portalId } });
      if (!row) return null;
      return {
        portalId: row.portalId,
        refreshToken: {
          ciphertext: row.refreshTokenCiphertext,
          iv: row.refreshTokenIv,
          authTag: row.refreshTokenAuthTag,
        },
        scopes: row.scopes,
        accessTokenExpiresAt: row.accessTokenExpiresAt,
        installedVia: row.installedVia === "hubspot_initiated" ? "hubspot_initiated" : "app_start",
      };
    },

    async recordRefresh(portalId, record) {
      const rotated = record.rotatedRefreshToken;
      await db.oAuthToken.update({
        where: { portalId },
        data: {
          accessTokenExpiresAt: record.accessTokenExpiresAt,
          lastRefreshedAt: record.at,
          lastRefreshError: Prisma.DbNull,
          lastRefreshErrorAt: null,
          ...(record.scopes ? { scopes: record.scopes } : {}),
          ...(rotated
            ? {
                refreshTokenCiphertext: bytes(rotated.ciphertext),
                refreshTokenIv: bytes(rotated.iv),
                refreshTokenAuthTag: bytes(rotated.authTag),
                refreshTokenRotatedAt: record.at,
              }
            : {}),
        },
      });
    },

    async recordRefreshFailure(portalId, failure) {
      const { at, ...detail } = failure;
      await db.oAuthToken.updateMany({
        where: { portalId },
        data: { lastRefreshError: { ...detail }, lastRefreshErrorAt: at },
      });
    },
  };
}

function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
