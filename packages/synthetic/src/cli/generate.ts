// pnpm --filter @repo/synthetic generate [--seed 42] [--set demo|eval|all] [--summary]
//
// Prints the seeded dataset as canonical JSON (the same bytes for the same seed), or with --summary a
// table of keys, scenarios and intended labels plus the dataset's sha256.
import { parseArgs } from "node:util";
import { datasetHash, generateDataset, serializeDataset } from "../dataset.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "42" },
    set: { type: "string", default: "all" },
    summary: { type: "boolean", default: false },
  },
});

const seed = Number(values.seed);
const dataset = generateDataset(seed);
if (values.summary) {
  console.log(`seed ${seed}  version ${dataset.version}  sha256 ${datasetHash(dataset)}`);
  for (const lead of [...dataset.demo, ...dataset.eval]) {
    if (values.set !== "all" && lead.set !== values.set) continue;
    console.log(
      [
        lead.key.padEnd(13),
        lead.siteKey.padEnd(15),
        lead.scenario.padEnd(15),
        lead.intended.triageDisposition.padEnd(13),
        lead.submittedAt.site.local,
        lead.click?.channel ?? "-",
      ].join("  "),
    );
  }
} else if (values.set === "demo" || values.set === "eval") {
  process.stdout.write(`${JSON.stringify(dataset[values.set], null, 2)}\n`);
} else {
  process.stdout.write(serializeDataset(dataset));
}
