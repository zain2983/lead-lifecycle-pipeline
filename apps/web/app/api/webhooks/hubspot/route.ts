import { loadEnv } from "@repo/core";
import { handleHubSpotWebhook } from "../../../../lib/hubspot/webhook.ts";

export const dynamic = "force-dynamic";

// Read at request time, not import time, so `next build` works without HubSpot credentials.
export async function POST(request: Request): Promise<Response> {
  const env = loadEnv(["hubspotWebhook"]);
  return handleHubSpotWebhook(request, {
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
  });
}
