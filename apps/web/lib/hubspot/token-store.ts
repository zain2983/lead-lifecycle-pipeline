import { type OAuthTokenStore, prismaOAuthTokenStore } from "@repo/crm-hubspot";
import { webDb } from "../db.ts";

/** The `oauth_token` table on the web app's shared Prisma client. Upserts by portal ID. */
export function prismaTokenStore(databaseUrl: string): OAuthTokenStore {
  return prismaOAuthTokenStore(webDb(databaseUrl).prisma);
}
