import { loadEnv } from "@repo/core";
import { startHubSpotOAuth } from "../../../../../lib/hubspot/oauth.ts";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const env = loadEnv(["hubspotOAuth"]);
  return startHubSpotOAuth({
    clientId: env.HUBSPOT_CLIENT_ID,
    redirectUri: env.HUBSPOT_REDIRECT_URI,
  });
}
