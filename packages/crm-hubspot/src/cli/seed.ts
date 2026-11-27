// pnpm hs:seed --account demo|eval --seed 42 [--dry-run]
//
// Upserts the account's synthetic leads as contacts, by email: 20 demo leads, or the 10 eval fixtures
// (@repo/synthetic). Reads first and sends only contacts that are missing or differ, so a second run
// changes nothing. Prints fixture keys and HubSpot IDs, never emails. Run `pnpm hs:setup` first: the
// custom properties must exist. Exit 0 / 1 (failed) / 2 (unknown outcome: re-run it, it's safe).
import { HubSpotApiError } from "../api.ts";
import { upsertContactsByEmail } from "../contacts.ts";
import { seedInputs } from "../seed.ts";
import { clientFor, countLine, exitCode, loadDotEnv, parseCli } from "./common.ts";

loadDotEnv();
const usage = "pnpm hs:seed --account demo|eval --seed <n> [--dry-run]";
const { account, values } = parseCli(usage, { seed: { type: "string" } });
const seed = Number(values.seed);
if (values.seed === undefined || !Number.isSafeInteger(seed) || seed < 0) {
  console.error(`--seed must be a non-negative integer\nusage: ${usage}`);
  process.exit(64);
}
const dryRun = values["dry-run"] === true;
const { client, target } = clientFor(account);
const inputs = seedInputs(account, seed);

console.log(
  `hs:seed   account ${account}  seed ${seed}  contacts ${inputs.length}${dryRun ? "  (dry run: reads only)" : ""}`,
);
console.log(`target    ${target}`);

let summary: Awaited<ReturnType<typeof upsertContactsByEmail>>;
try {
  summary = await upsertContactsByEmail(client, inputs, { dryRun });
} catch (error) {
  console.log(
    `error     ${error instanceof HubSpotApiError ? `${error.status} ${error.body}` : (error as Error).message}`,
  );
  process.exit(1);
}

for (const r of summary.results) {
  const verb = dryRun && r.action !== "unchanged" ? `would be ${r.action}` : r.action;
  const detail = r.action === "updated" ? `  (${r.changes.join(", ")})` : "";
  console.log(
    `${(r.label ?? "").padEnd(13)} id ${(r.id ?? "-").padEnd(12)} ${verb}${detail}${r.error ? `\n          ${r.error}` : ""}`,
  );
}
const { requests, retries, rateLimitWaits } = client.stats;
console.log(
  `summary   ${countLine(summary.counts)}  (requests ${requests}: upserts ${summary.upsertRequests}; retries ${retries}, rate-limit waits ${rateLimitWaits})`,
);
process.exit(exitCode(summary.counts));
