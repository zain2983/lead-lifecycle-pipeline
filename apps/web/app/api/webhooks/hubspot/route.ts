import { loadEnv } from "@repo/core";
import { fileCapture } from "../../../../lib/hubspot/capture.ts";
import { handleHubSpotWebhook } from "../../../../lib/hubspot/webhook.ts";

export const dynamic = "force-dynamic";

// Read at request time, not import time, so `next build` works without HubSpot credentials.
export async function POST(request: Request): Promise<Response> {
  const env = loadEnv(["hubspotWebhook"]);
  return handleHubSpotWebhook(request, {
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
    // Local live tests only; ignored on Vercel even if set by mistake.
    capture:
      env.HUBSPOT_WEBHOOK_CAPTURE_DIR && !process.env.VERCEL
        ? fileCapture(env.HUBSPOT_WEBHOOK_CAPTURE_DIR)
        : undefined,
  });
}
