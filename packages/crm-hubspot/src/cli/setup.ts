// pnpm hs:setup --account demo|eval [--dry-run]
//
// Makes the account's contact properties match CONTACT_PROPERTIES (properties.ts): the property group,
// triage_disposition, triage_confidence, the session handle, the click IDs, consent state and the fixture
// key. Reads first; creates what's missing, updates only fields that differ, leaves the rest. Safe to re-run.
// Exit 0 when everything is in place, 1 if anything failed, 2 if a write's outcome is unknown (re-run it).
import { HubSpotApiError } from "../api.ts";
import { ensureContactProperties, PROPERTY_GROUP } from "../properties.ts";
import { clientFor, countLine, exitCode, loadDotEnv, parseCli } from "./common.ts";

loadDotEnv();
const { account, values } = parseCli("pnpm hs:setup --account demo|eval [--dry-run]");
const dryRun = values["dry-run"] === true;
const { client, target } = clientFor(account);

console.log(`hs:setup  account ${account}${dryRun ? "  (dry run: reads only)" : ""}`);
console.log(`target    ${target}`);
console.log(`group     ${PROPERTY_GROUP.name} (contacts)`);

let results: Awaited<ReturnType<typeof ensureContactProperties>>;
try {
  results = await ensureContactProperties(client, { dryRun });
} catch (error) {
  // A read failed (auth, scope, network): nothing was written by this run after that point.
  console.log(
    `error     ${error instanceof HubSpotApiError ? `${error.status} ${error.body}` : (error as Error).message}`,
  );
  process.exit(1);
}

const counts: Record<string, number> = {};
for (const r of results) {
  counts[r.action] = (counts[r.action] ?? 0) + 1;
  const verb = dryRun && r.action !== "unchanged" ? `would be ${r.action}` : r.action;
  const detail = r.action === "updated" ? `  (${r.changes.join(", ")})` : "";
  console.log(
    `${r.kind.padEnd(9)} ${r.name.padEnd(28)} ${verb}${detail}${r.error ? `\n          ${r.error}` : ""}`,
  );
}
const { requests, retries, rateLimitWaits } = client.stats;
console.log(
  `summary   ${countLine(counts)}  (requests ${requests}, retries ${retries}, rate-limit waits ${rateLimitWaits})`,
);
process.exit(exitCode(counts));
