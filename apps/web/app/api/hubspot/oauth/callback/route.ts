import { loadEnv } from "@repo/core";
import { parseEncryptionKey } from "@repo/crm-hubspot";
import { completeHubSpotOAuth } from "../../../../../lib/hubspot/oauth.ts";
import { prismaTokenStore } from "../../../../../lib/hubspot/token-store.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const env = loadEnv(["database", "hubspotOAuth"]);
  return completeHubSpotOAuth(request, {
    clientId: env.HUBSPOT_CLIENT_ID,
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    redirectUri: env.HUBSPOT_REDIRECT_URI,
    tokenUrl: env.HUBSPOT_OAUTH_TOKEN_URL,
    encryptionKey: parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY),
    store: prismaTokenStore(env.DATABASE_URL),
    knownPortalIds: env.HUBSPOT_KNOWN_PORTAL_IDS,
  });
}
