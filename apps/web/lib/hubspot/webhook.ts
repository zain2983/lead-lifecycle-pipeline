import {
  parseWebhookBatch,
  REQUEST_TIMESTAMP_HEADER,
  SIGNATURE_V3_HEADER,
  signedUriFor,
  verifySignatureV3,
} from "@repo/crm-hubspot";

export interface HubSpotWebhookConfig {
  clientSecret: string;
  /** PUBLIC_WEBHOOK_URL: the URL HubSpot was told to call (tunnel locally, production on Vercel). */
  publicWebhookUrl: string;
  now?: () => number;
}

/**
 * POST /api/webhooks/hubspot. Verifies signature v3 against the raw body, then answers at once.
 * HubSpot retries any 4xx/5xx or anything slower than 5 s, up to 10 times over 24 hours.
 *
 * Phase 1 (this spike): count the events and return 200. Phase 3 inserts each event as a `CrmEvent`
 * (ON CONFLICT DO NOTHING) and enqueues it in the same transaction before answering.
 */
export async function handleHubSpotWebhook(
  request: Request,
  config: HubSpotWebhookConfig,
): Promise<Response> {
  // The raw bytes, before any JSON parsing: the signature covers exactly what was sent.
  const rawBody = await request.text();
  const check = verifySignatureV3({
    method: request.method,
    uri: signedUriFor(config.publicWebhookUrl, request.url),
    rawBody,
    timestamp: request.headers.get(REQUEST_TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_V3_HEADER),
    clientSecret: config.clientSecret,
    now: config.now?.(),
  });
  if (!check.ok) {
    console.warn(JSON.stringify({ msg: "hubspot webhook rejected", reason: check.reason }));
    return Response.json(
      { ok: false, error: "invalid_signature", reason: check.reason },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  const batch = parseWebhookBatch(rawBody);
  if (!batch.ok) {
    console.warn(JSON.stringify({ msg: "hubspot webhook unreadable", error: batch.error }));
    return Response.json(
      { ok: false, error: batch.error, issues: batch.issues },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const types: Record<string, number> = {};
  for (const event of batch.events) {
    types[event.subscriptionType] = (types[event.subscriptionType] ?? 0) + 1;
  }
  console.info(
    JSON.stringify({ msg: "hubspot webhook accepted", received: batch.events.length, types }),
  );
  return Response.json(
    { ok: true, received: batch.events.length },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
