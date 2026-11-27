// pnpm hs:replay <fixture.json> [--url <target>] [--tamper] [--age <seconds>] [--expect <status>]
//
// Signs a recorded (or synthetic) webhook batch the way HubSpot does (signature v3, HUBSPOT_CLIENT_SECRET,
// against PUBLIC_WEBHOOK_URL) and POSTs it. This is the default local loop: no HubSpot account, no tunnel.
//
//   --url      where to POST (default PUBLIC_WEBHOOK_URL). The signature still uses PUBLIC_WEBHOOK_URL's
//              scheme and host, exactly as the receiver checks it, so you can sign for a tunnel URL and
//              POST straight to localhost.
//   --tamper   change the body after signing (the receiver must answer 401).
//   --age      backdate the timestamp by this many seconds (over 300 must give 401).
//   --expect   exit 0 only if the response has this status (default: any 2xx).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnv } from "@repo/core";
import {
  REQUEST_TIMESTAMP_HEADER,
  SIGNATURE_V3_HEADER,
  signatureV3,
  signedUriFor,
} from "../signature.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch {
  // No .env: the variables come from the environment.
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    tamper: { type: "boolean", default: false },
    age: { type: "string", default: "0" },
    expect: { type: "string" },
  },
});

const [fixtureArg] = positionals;
if (!fixtureArg) {
  console.error(
    "usage: pnpm hs:replay <fixture.json> [--url <target>] [--tamper] [--age <seconds>] [--expect <status>]",
  );
  process.exit(64);
}

const env = loadEnv(["hubspotWebhook"]);
// pnpm runs the script from the package directory; resolve the path from where the user typed it.
const fixturePath = path.resolve(process.env.INIT_CWD ?? process.cwd(), fixtureArg);
// HubSpot sends compact JSON, so the fixture's formatting doesn't matter.
const events = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>[];
const rawBody = JSON.stringify(events);
const target = values.url ?? env.PUBLIC_WEBHOOK_URL;
const timestamp = String(Date.now() - Number(values.age) * 1000);
const signedUri = signedUriFor(env.PUBLIC_WEBHOOK_URL, target);
const signature = signatureV3({
  method: "POST",
  uri: signedUri,
  rawBody,
  timestamp,
  clientSecret: env.HUBSPOT_CLIENT_SECRET,
});

let sentBody = rawBody;
if (values.tamper) {
  const first = events[0];
  if (first && typeof first.objectId === "number") first.objectId += 1;
  sentBody = JSON.stringify(events);
}

const types = [...new Set(events.map((event) => String(event.subscriptionType)))].join(", ");
console.log(
  `fixture       ${path.relative(repoRoot, fixturePath)} (${events.length} event(s): ${types})`,
);
console.log(`POST          ${target}`);
console.log(`signed URI    ${signedUri}`);
console.log(
  `timestamp     ${timestamp}${values.age !== "0" ? ` (backdated ${values.age} s)` : ""}`,
);
console.log(`signature v3  ${signature.slice(0, 6)}… (redacted)`);
if (values.tamper) console.log("tampered      first event's objectId changed after signing");

const started = performance.now();
let response: Response;
try {
  response = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "lead-lifecycle-pipeline hs:replay",
      [SIGNATURE_V3_HEADER]: signature,
      [REQUEST_TIMESTAMP_HEADER]: timestamp,
    },
    body: sentBody,
    signal: AbortSignal.timeout(10_000),
  });
} catch (error) {
  // No answer is not a rejection: the receiver may or may not have processed it.
  console.log(`result        unknown (no response: ${(error as Error).message})`);
  process.exit(2);
}
const elapsed = Math.round(performance.now() - started);
const text = await response.text();
console.log(`response      ${response.status} in ${elapsed} ms`);
console.log(`body          ${text}`);

const expected = values.expect === undefined ? undefined : Number(values.expect);
const ok = expected === undefined ? response.ok : response.status === expected;
process.exit(ok ? 0 : 1);
