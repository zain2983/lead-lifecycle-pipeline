import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { signatureV3 } from "@repo/crm-hubspot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileCapture } from "../lib/hubspot/capture.ts";
import { handleHubSpotWebhook, type WebhookCapture } from "../lib/hubspot/webhook.ts";

const fixtures = path.resolve(import.meta.dirname, "../../../packages/crm-hubspot/fixtures");
const fixture = (name: string) =>
  JSON.stringify(JSON.parse(readFileSync(path.join(fixtures, name), "utf8")));

const clientSecret = "test-client-secret-0001";
const publicWebhookUrl = "https://quick-tunnel.example.test/api/webhooks/hubspot";
const now = 1_795_791_850_000;
const config = { clientSecret, publicWebhookUrl, now: () => now };

interface Delivery {
  body: string;
  /** The URL the request reaches the server with (Host header + path). */
  requestUrl?: string;
  /** The URI HubSpot signs. */
  signedUri?: string;
  sentAt?: number;
  tamper?: (body: string) => string;
}

function delivery({
  body,
  requestUrl = "http://localhost:3100/api/webhooks/hubspot",
  signedUri = publicWebhookUrl,
  sentAt = now - 1_000,
  tamper = (b) => b,
}: Delivery): Request {
  const timestamp = String(sentAt);
  const signature = signatureV3({
    method: "POST",
    uri: signedUri,
    rawBody: body,
    timestamp,
    clientSecret,
  });
  return new Request(requestUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hubspot-signature-v3": signature,
      "x-hubspot-request-timestamp": timestamp,
    },
    body: tamper(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("POST /api/webhooks/hubspot", () => {
  it("accepts a signed contact creation and answers with the event count", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(
      delivery({ body: fixture("contact-creation.json") }),
      config,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, received: 1 });
  });

  it("counts every event in a batch", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(
      delivery({ body: fixture("batch-mixed.json") }),
      config,
    );
    expect(await response.json()).toEqual({ ok: true, received: 4 });
  });

  it("returns 401 for a tampered body", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(
      delivery({
        body: fixture("contact-lifecyclestage-change.json"),
        tamper: (b) => b.replace("marketingqualifiedlead", "customer"),
      }),
      config,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_signature",
      reason: "signature_mismatch",
    });
  });

  it("returns 401 for a request older than 5 minutes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(
      delivery({ body: fixture("contact-creation.json"), sentAt: now - 6 * 60_000 }),
      config,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "timestamp_too_old" });
  });

  it("returns 401 when the headers are missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = new Request("http://localhost:3100/api/webhooks/hubspot", {
      method: "POST",
      body: fixture("contact-creation.json"),
    });
    const response = await handleHubSpotWebhook(request, config);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "missing_signature" });
  });

  it("verifies against PUBLIC_WEBHOOK_URL whatever the Host header says", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = fixture("contact-creation.json");
    // HubSpot signed the public URL; the request reaches us with an unrelated Host. Still valid.
    const viaProxy = await handleHubSpotWebhook(
      delivery({ body, requestUrl: "http://10.0.0.7:3100/api/webhooks/hubspot" }),
      config,
    );
    expect(viaProxy.status).toBe(200);
    // Someone who signs for the host they send us (rather than the public URL) is rejected.
    const forged = await handleHubSpotWebhook(
      delivery({
        body,
        requestUrl: "https://attacker.example.test/api/webhooks/hubspot",
        signedUri: "https://attacker.example.test/api/webhooks/hubspot",
      }),
      config,
    );
    expect(forged.status).toBe(401);
  });

  it("verifies a target URL whose query string is URL-encoded", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const query = "?env=dev&next=https%3A%2F%2Fapp.example.test%2Fdone";
    const response = await handleHubSpotWebhook(
      delivery({
        body: fixture("contact-creation.json"),
        requestUrl: `http://localhost:3100/api/webhooks/hubspot${query}`,
        signedUri: `${publicWebhookUrl}${query}`,
      }),
      { ...config, publicWebhookUrl: `${publicWebhookUrl}${query}` },
    );
    expect(response.status).toBe(200);
  });

  it("returns 400 for a correctly signed body that is not an event batch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(delivery({ body: '{"hello":"world"}' }), config);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_shape" });
  });
});

// The route module itself (env at request time, real database) is tested in hubspot-intake.test.ts.

describe("delivery capture (HUBSPOT_WEBHOOK_CAPTURE_DIR)", () => {
  it("keeps accepted and rejected deliveries exactly as received", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: WebhookCapture[] = [];
    const capture = async (delivery: WebhookCapture) => void captured.push(delivery);
    const body = fixture("contact-creation.json");
    await handleHubSpotWebhook(delivery({ body }), { ...config, capture });
    await handleHubSpotWebhook(delivery({ body, tamper: (b) => `${b} ` }), { ...config, capture });

    expect(captured.map((c) => c.status)).toEqual([200, 401]);
    expect(captured[0]).toMatchObject({
      method: "POST",
      requestUrl: "http://localhost:3100/api/webhooks/hubspot",
      signedUri: publicWebhookUrl,
      rawBody: body,
      response: { ok: true, received: 1 },
    });
    expect(captured[0]?.headers["x-hubspot-request-timestamp"]).toBeDefined();
    expect(captured[1]?.rawBody).toBe(`${body} `);
  });

  it("answers normally when the capture fails", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await handleHubSpotWebhook(
      delivery({ body: fixture("contact-creation.json") }),
      {
        ...config,
        capture: async () => {
          throw new Error("disk full");
        },
      },
    );
    expect(response.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture failed"));
  });

  it("writes one JSON file per delivery", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const dir = await mkdtemp(path.join(tmpdir(), "hubspot-capture-"));
    try {
      await handleHubSpotWebhook(delivery({ body: fixture("contact-creation.json") }), {
        ...config,
        capture: fileCapture(dir),
      });
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/-200-[0-9a-f]{8}\.json$/);
      const saved = JSON.parse(await readFile(path.join(dir, files[0] ?? ""), "utf8"));
      expect(saved.rawBody).toBe(fixture("contact-creation.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
