import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HubSpot request signature v3.
 * Docs: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation
 *
 *   signature = base64(HMAC-SHA256(clientSecret, method + uri + rawBody + timestamp))
 *
 * - `uri` is the full URL HubSpot called, with a fixed list of percent-encoded characters decoded in the
 *   query string only (see `DECODED_IN_QUERY`), and without a fragment.
 * - `rawBody` is the body exactly as received. HubSpot's Node sample re-serialises the parsed body with
 *   `JSON.stringify`, which breaks as soon as the bytes differ (whitespace, key order, unicode escapes).
 * - `timestamp` is the `X-HubSpot-Request-Timestamp` header (milliseconds), used as the exact string sent.
 */

export const SIGNATURE_V3_HEADER = "x-hubspot-signature-v3";
export const REQUEST_TIMESTAMP_HEADER = "x-hubspot-request-timestamp";

/** HubSpot: "Reject the request if the timestamp is older than 5 minutes." Also applied to the future. */
export const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** The table in HubSpot's docs. Uppercase only, as in all three of HubSpot's samples. */
const DECODED_IN_QUERY: Readonly<Record<string, string>> = {
  "%3A": ":",
  "%2F": "/",
  "%3F": "?",
  "%40": "@",
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%3B": ";",
};
const DECODED_IN_QUERY_PATTERN = /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/g;

/**
 * The URI as it goes into the signed string: fragment dropped, and the listed characters decoded in the
 * query string. The path is left alone, and so is the `?` that starts the query.
 */
export function normalizeSignedUri(uri: string): string {
  const hash = uri.indexOf("#");
  const withoutFragment = hash === -1 ? uri : uri.slice(0, hash);
  const queryStart = withoutFragment.indexOf("?");
  if (queryStart === -1) return withoutFragment;
  const head = withoutFragment.slice(0, queryStart + 1);
  const query = withoutFragment
    .slice(queryStart + 1)
    .replace(DECODED_IN_QUERY_PATTERN, (match) => DECODED_IN_QUERY[match] ?? match);
  return head + query;
}

/**
 * The URI to sign or verify. Scheme, host and port come from `PUBLIC_WEBHOOK_URL` (the URL HubSpot was
 * told to call); only the path and query come from the request. The request's own origin is built from
 * the Host / X-Forwarded-Host headers, which the caller controls, so it is never trusted.
 */
export function signedUriFor(publicWebhookUrl: string, requestUrl: string): string {
  const trusted = new URL(publicWebhookUrl);
  const received = new URL(requestUrl, trusted);
  return `${trusted.protocol}//${trusted.host}${received.pathname}${received.search}`;
}

export interface SignatureV3Input {
  method: string;
  /** Full URI, not yet normalised: `normalizeSignedUri` is applied here. */
  uri: string;
  rawBody: string;
  /** The timestamp header value, exactly as sent. */
  timestamp: string;
  clientSecret: string;
}

/** Compute the v3 signature. Used by `hs:replay` to sign fixtures, and by the verifier. */
export function signatureV3(input: SignatureV3Input): string {
  assertSecret(input.clientSecret);
  const source = `${input.method.toUpperCase()}${normalizeSignedUri(input.uri)}${input.rawBody}${input.timestamp}`;
  return createHmac("sha256", input.clientSecret).update(source, "utf8").digest("base64");
}

export type SignatureV3Failure =
  | "missing_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "timestamp_too_old"
  | "timestamp_in_future"
  | "signature_mismatch";

export type SignatureV3Result = { ok: true } | { ok: false; reason: SignatureV3Failure };

export interface VerifySignatureV3Input {
  method: string;
  uri: string;
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  clientSecret: string;
  /** Current time in milliseconds. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Verify a v3 signature. Checks the timestamp window first (a stale request is rejected even if it was
 * signed correctly, so a captured request can't be replayed later), then compares in constant time.
 */
export function verifySignatureV3(input: VerifySignatureV3Input): SignatureV3Result {
  assertSecret(input.clientSecret);
  const { signature, timestamp } = input;
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, reason: "invalid_timestamp" };

  const now = input.now ?? Date.now();
  const sentAt = Number(timestamp);
  if (now - sentAt > MAX_TIMESTAMP_SKEW_MS) return { ok: false, reason: "timestamp_too_old" };
  if (sentAt - now > MAX_TIMESTAMP_SKEW_MS) return { ok: false, reason: "timestamp_in_future" };

  const expected = Buffer.from(signatureV3({ ...input, timestamp }), "utf8");
  const received = Buffer.from(signature, "utf8");
  // The expected length is public (always 44 base64 characters), so checking it first leaks nothing.
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

function assertSecret(clientSecret: string): void {
  // An empty HMAC key would let anyone produce a valid signature: treat it as a configuration error.
  if (!clientSecret) throw new Error("HubSpot client secret is empty");
}
