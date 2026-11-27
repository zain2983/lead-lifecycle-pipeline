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
  /** Local live tests only (HUBSPOT_WEBHOOK_CAPTURE_DIR): keep every delivery exactly as received. */
  capture?: (delivery: WebhookCapture) => Promise<void>;
}

/** One delivery as received, with what the receiver made of it. */
export interface WebhookCapture {
  receivedAt: string;
  method: string;
  requestUrl: string;
  signedUri: string;
  /** All request headers except cookie and authorization. */
  headers: Record<string, string>;
  rawBody: string;
  status: number;
  response: Record<string, unknown>;
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
  const receivedAt = new Date().toISOString();
  // The raw bytes, before any JSON parsing: the signature covers exactly what was sent.
  const rawBody = await request.text();
  const signedUri = signedUriFor(config.publicWebhookUrl, request.url);
  const { status, body } = evaluate(request, rawBody, signedUri, config);

  if (config.capture) {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (name !== "cookie" && name !== "authorization") headers[name] = value;
    });
    try {
      await config.capture({
        receivedAt,
        method: request.method,
        requestUrl: request.url,
        signedUri,
        headers,
        rawBody,
        status,
        response: body,
      });
    } catch (error) {
      console.warn(JSON.stringify({ msg: "hubspot webhook capture failed", error: String(error) }));
    }
  }
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function evaluate(
  request: Request,
  rawBody: string,
  signedUri: string,
  config: HubSpotWebhookConfig,
): { status: number; body: Record<string, unknown> } {
  const check = verifySignatureV3({
    method: request.method,
    uri: signedUri,
    rawBody,
    timestamp: request.headers.get(REQUEST_TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_V3_HEADER),
    clientSecret: config.clientSecret,
    now: config.now?.(),
  });
  if (!check.ok) {
    console.warn(JSON.stringify({ msg: "hubspot webhook rejected", reason: check.reason }));
    return { status: 401, body: { ok: false, error: "invalid_signature", reason: check.reason } };
  }

  const batch = parseWebhookBatch(rawBody);
  if (!batch.ok) {
    console.warn(JSON.stringify({ msg: "hubspot webhook unreadable", error: batch.error }));
    return { status: 400, body: { ok: false, error: batch.error, issues: batch.issues } };
  }

  const types: Record<string, number> = {};
  for (const event of batch.events) {
    types[event.subscriptionType] = (types[event.subscriptionType] ?? 0) + 1;
  }
  console.info(
    JSON.stringify({ msg: "hubspot webhook accepted", received: batch.events.length, types }),
  );
  return { status: 200, body: { ok: true, received: batch.events.length } };
}
