import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_TIMESTAMP_SKEW_MS,
  normalizeSignedUri,
  signatureV3,
  signedUriFor,
  verifySignatureV3,
} from "../src/signature.ts";

const secret = "test-client-secret-0001";
const uri = "https://hooks.example.test/api/webhooks/hubspot";
const body =
  '[{"eventId":1,"subscriptionId":2,"portalId":3,"appId":4,"occurredAt":1795791845120,"subscriptionType":"object.creation","attemptNumber":0,"objectId":5,"objectTypeId":"0-1"}]';
const now = 1_795_791_850_000;
const timestamp = String(now - 2_000);

function sign(overrides: Partial<Parameters<typeof signatureV3>[0]> = {}) {
  return signatureV3({
    method: "POST",
    uri,
    rawBody: body,
    timestamp,
    clientSecret: secret,
    ...overrides,
  });
}

function verify(overrides: Partial<Parameters<typeof verifySignatureV3>[0]> = {}) {
  return verifySignatureV3({
    method: "POST",
    uri,
    rawBody: body,
    timestamp,
    signature: sign(),
    clientSecret: secret,
    now,
    ...overrides,
  });
}

describe("verifySignatureV3", () => {
  it("accepts HubSpot's published example (Java tab of the request-validation docs)", () => {
    // From https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
    // The secret is HubSpot's documentation sample, not a credential.
    const example = {
      clientSecret: "cfc68c0b-4b4e-4ef8-b764-95350e4ea479",
      method: "POST",
      uri: "https://webhook.site/335453f5-94b3-49d9-b684-a55354d4b8df",
      rawBody:
        '[{"eventId":531833541,"subscriptionId":3923621,"portalId":48807704,"appId":16111050,"occurredAt":1752613920733,"subscriptionType":"contact.creation","attemptNumber":0,"objectId":138017612137,"changeFlag":"CREATED","changeSource":"CRM_UI","sourceId":"userId:76023669"}]',
      timestamp: "1752613922216",
      signature: "gbj1XPRvUt0noT7i7fXfTzOD4sLzQmf0VT28ZYq0EYg=",
    };
    expect(verifySignatureV3({ ...example, now: 1752613922216 + 1_000 })).toEqual({ ok: true });
    // The same request, checked at today's date, is far outside the 5-minute window.
    expect(verifySignatureV3({ ...example, now })).toEqual({
      ok: false,
      reason: "timestamp_too_old",
    });
  });

  it("accepts a valid signature", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("is base64 HMAC-SHA256 over method + uri + body + timestamp", () => {
    const expected = createHmac("sha256", secret)
      .update(`POST${uri}${body}${timestamp}`)
      .digest("base64");
    expect(sign()).toBe(expected);
  });

  it("rejects a signature made with another secret", () => {
    expect(verify({ signature: sign({ clientSecret: "another-secret" }) })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a garbage or truncated signature without throwing", () => {
    expect(verify({ signature: "not-base64" })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
    expect(verify({ signature: sign().slice(0, -1) })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a tampered body", () => {
    const tampered = body.replace('"objectId":5', '"objectId":6');
    expect(verify({ rawBody: tampered })).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects a changed URI, method or timestamp", () => {
    expect(verify({ uri: `${uri}?x=1` })).toMatchObject({ ok: false });
    expect(verify({ method: "PUT" })).toMatchObject({ ok: false });
    expect(verify({ timestamp: String(Number(timestamp) + 1) })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("verifies the raw body, not a re-serialised one", () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    const signature = sign({ rawBody: pretty });
    expect(verify({ rawBody: pretty, signature })).toEqual({ ok: true });
    // What HubSpot's Node sample does (JSON.stringify of the parsed body) fails on the same request.
    expect(verify({ rawBody: JSON.stringify(JSON.parse(pretty)), signature })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects a timestamp older than 5 minutes, and accepts one exactly at the limit", () => {
    const signedAt = (sentAt: number) => ({
      timestamp: String(sentAt),
      signature: sign({ timestamp: String(sentAt) }),
    });
    expect(verify(signedAt(now - MAX_TIMESTAMP_SKEW_MS - 1))).toEqual({
      ok: false,
      reason: "timestamp_too_old",
    });
    expect(verify(signedAt(now - MAX_TIMESTAMP_SKEW_MS))).toEqual({ ok: true });
  });

  it("rejects a timestamp more than 5 minutes in the future, and tolerates small clock skew", () => {
    const signedAt = (sentAt: number) => ({
      timestamp: String(sentAt),
      signature: sign({ timestamp: String(sentAt) }),
    });
    expect(verify(signedAt(now + 10 * 60_000))).toEqual({
      ok: false,
      reason: "timestamp_in_future",
    });
    expect(verify(signedAt(now + 30_000))).toEqual({ ok: true });
  });

  it("rejects missing or malformed headers", () => {
    expect(verify({ signature: null })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verify({ timestamp: undefined })).toEqual({ ok: false, reason: "missing_timestamp" });
    expect(verify({ timestamp: "1795791848000.5" })).toEqual({
      ok: false,
      reason: "invalid_timestamp",
    });
    expect(verify({ timestamp: "-1" })).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("refuses to run with an empty client secret", () => {
    expect(() => verify({ clientSecret: "" })).toThrowError(/empty/);
  });
});

describe("URL-encoded query strings", () => {
  // HubSpot decodes these twelve characters in the query string before signing.
  const encoded =
    "https://hooks.example.test/api/webhooks/hubspot?next=https%3A%2F%2Fapp.example.com%2Fdone%3Fa%3D1&tags=a%2Cb%3Bc&who=x%40example.test&misc=%21%24%27%28%29%2A";
  const decoded =
    "https://hooks.example.test/api/webhooks/hubspot?next=https://app.example.com/done?a%3D1&tags=a,b;c&who=x@example.test&misc=!$'()*";

  it("decodes exactly the documented characters in the query", () => {
    expect(normalizeSignedUri(encoded)).toBe(decoded);
  });

  it("verifies a request whose URL has an encoded query string", () => {
    const sentAt = String(now);
    // What HubSpot computes: the HMAC over the decoded URI. Built here without normalizeSignedUri.
    const signature = createHmac("sha256", secret)
      .update(`POST${decoded}${body}${sentAt}`)
      .digest("base64");
    expect(
      verifySignatureV3({
        method: "POST",
        uri: encoded,
        rawBody: body,
        timestamp: sentAt,
        signature,
        clientSecret: secret,
        now,
      }),
    ).toEqual({ ok: true });
  });

  it("leaves other escapes, lowercase escapes and the path alone", () => {
    expect(normalizeSignedUri("https://h.example.test/a%2Fb%3A?q=%20%2B%26%3D%25%3a%2f%2F")).toBe(
      "https://h.example.test/a%2Fb%3A?q=%20%2B%26%3D%25%3a%2f/",
    );
  });

  it("drops the fragment and leaves a URI without a query unchanged", () => {
    expect(normalizeSignedUri(`${uri}?a=%2F#frag%2F`)).toBe(`${uri}?a=/`);
    expect(normalizeSignedUri(uri)).toBe(uri);
  });
});

describe("signedUriFor", () => {
  const publicUrl = "https://quick-tunnel.example.test/api/webhooks/hubspot";

  it("takes scheme and host from PUBLIC_WEBHOOK_URL, path and query from the request", () => {
    expect(signedUriFor(publicUrl, "http://localhost:3100/api/webhooks/hubspot?env=dev")).toBe(
      "https://quick-tunnel.example.test/api/webhooks/hubspot?env=dev",
    );
  });

  it("ignores a spoofed Host header", () => {
    // Next builds request.url from the Host / X-Forwarded-Host headers, which the caller controls.
    expect(signedUriFor(publicUrl, "https://attacker.example.test/api/webhooks/hubspot")).toBe(
      publicUrl,
    );
  });

  it("keeps a non-default port and the encoded query as received", () => {
    expect(
      signedUriFor(
        "http://localhost:3100/api/webhooks/hubspot",
        "http://127.0.0.1:9999/api/webhooks/hubspot?r=a%2Fb",
      ),
    ).toBe("http://localhost:3100/api/webhooks/hubspot?r=a%2Fb");
  });

  it("accepts a path-only request URL", () => {
    expect(signedUriFor(publicUrl, "/api/webhooks/hubspot")).toBe(publicUrl);
  });
});
