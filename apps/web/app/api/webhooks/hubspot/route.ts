import { loadEnv } from "@repo/core";
import type { HubSpotWebhookEvent } from "@repo/crm-hubspot";
import { startWebBoss, webDb } from "../../../../lib/db.ts";
import { fileCapture } from "../../../../lib/hubspot/capture.ts";
import { ingestHubSpotEvents } from "../../../../lib/hubspot/intake.ts";
import { handleHubSpotWebhook } from "../../../../lib/hubspot/webhook.ts";

export const dynamic = "force-dynamic";
/** HubSpot gives up after 5 s; the intake's transaction times out at 4 s and answers 500 instead. */
export const maxDuration = 10;

/** One pg-boss instance per invocation on the shared pool, stopped before the answer goes out. */
async function ingest(databaseUrl: string, events: HubSpotWebhookEvent[]) {
  const db = webDb(databaseUrl);
  const boss = await startWebBoss(db);
  try {
    return { ...(await ingestHubSpotEvents(db.prisma, boss, events)) };
  } finally {
    await boss.stop({ timeout: 2_000 });
  }
}

// Read at request time, not import time, so `next build` works without HubSpot credentials.
export async function POST(request: Request): Promise<Response> {
  const env = loadEnv(["hubspotWebhook", "database"]);
  return handleHubSpotWebhook(request, {
    clientSecret: env.HUBSPOT_CLIENT_SECRET,
    publicWebhookUrl: env.PUBLIC_WEBHOOK_URL,
    ingest: (events) => ingest(env.DATABASE_URL, events),
    // Local live tests only; ignored on Vercel even if set by mistake.
    capture:
      env.HUBSPOT_WEBHOOK_CAPTURE_DIR && !process.env.VERCEL
        ? fileCapture(env.HUBSPOT_WEBHOOK_CAPTURE_DIR)
        : undefined,
  });
}
