// Offline evidence for Phase 2.3/2.4: runs the real root commands (`pnpm hs:setup`, `pnpm hs:seed`) against
// the in-process fake HubSpot from @repo/crm-hubspot/testing, and prints a transcript. Nothing here talks to
// HubSpot; every response comes from the fake (x-fake-hubspot: 1) and the CLIs say "NOT HubSpot".
//
//   pnpm --filter @repo/crm-hubspot exec tsx ../../docs/evidence/phase-2/offline-run.ts > docs/evidence/phase-2/offline-run.txt
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { startFakeHubSpot } from "../../../packages/crm-hubspot/src/testing/index.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const KEYS = { demo: "synthetic-demo-service-key", eval: "synthetic-eval-service-key" };

const fakes = {
  demo: await startFakeHubSpot({ token: KEYS.demo }),
  eval: await startFakeHubSpot({ token: KEYS.eval }),
};

function stateHash(account: keyof typeof fakes): string {
  const json = JSON.stringify(fakes[account].snapshot());
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

async function step(account: keyof typeof fakes, args: string[], note = "") {
  const fake = fakes[account];
  const writesBefore = fake.writes().length;
  const requestsBefore = fake.requests.length;
  const command = `pnpm ${args.join(" ")}`;
  // One buffer for stdout and stderr, in arrival order, as a terminal would show them.
  const result = await new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        HUBSPOT_API_BASE_URL: fake.url,
        // The CLI reads only the chosen account's key; the other stays unset.
        ...(account === "demo"
          ? { HUBSPOT_SERVICE_KEY_DEMO: KEYS.demo }
          : { HUBSPOT_SERVICE_KEY_EVAL: KEYS.eval }),
      },
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
  const snapshot = fake.snapshot();
  const custom = snapshot.properties.filter((p) => !p.hubspotDefined).length;
  console.log(`\n$ ${command}${note ? `    # ${note}` : ""}`);
  process.stdout.write(
    result.out.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>").replaceAll(repoRoot, "<repo>"),
  );
  console.log(
    `[exit ${result.code}] fake ${account}: requests +${fake.requests.length - requestsBefore}, writes +${fake.writes().length - writesBefore}; ` +
      `state ${stateHash(account)} (${custom} custom properties, ${snapshot.contacts.length} contacts)`,
  );
}

console.log(
  `# Phase 2 offline run, ${new Date().toISOString().slice(0, 10)}. Fake HubSpot, not HubSpot.`,
);
console.log(
  "# Each step shows the command, its output, the exit code, and the fake's request/write counts and a",
);
console.log("# hash of its whole state (equal hashes = identical end state).");

for (const account of ["demo", "eval"] as const) {
  console.log(`\n## ${account}`);
  await step(account, ["hs:setup", "--account", account, "--dry-run"], "plan only");
  await step(account, ["hs:setup", "--account", account], "first run");
  await step(account, ["hs:setup", "--account", account], "second run: no changes");
  await step(account, ["hs:seed", "--account", account, "--seed", "42", "--dry-run"], "plan only");
  await step(account, ["hs:seed", "--account", account, "--seed", "42"], "first run");
  await step(account, ["hs:seed", "--account", account, "--seed", "42"], "second run: no changes");
}

console.log("\n## Failure handling (demo fake)");
fakes.demo.mutate.property("triage_disposition", { label: "Renamed in the UI" });
fakes.demo.mutate.contact(fakes.demo.snapshot().contacts[0]?.properties.email ?? "", {
  firstname: "Edited",
});
fakes.demo.failNext(
  { method: "POST", path: /batch\/read$/ },
  {
    status: 429,
    body: {
      status: "error",
      message: "You have reached your ten_secondly_rolling limit.",
      errorType: "RATE_LIMIT",
      policyName: "TEN_SECONDLY_ROLLING",
    },
  },
  2,
);
await step("demo", ["hs:setup", "--account", "demo"], "drift: a label renamed in the UI");
await step(
  "demo",
  ["hs:seed", "--account", "demo", "--seed", "42"],
  "drift: one contact edited; two 429s first",
);
fakes.demo.failNext({ method: "POST", path: /batch\/upsert$/ }, "hang", 1);
await step(
  "demo",
  ["hs:seed", "--account", "demo", "--seed", "43"],
  "seed 43 (20 new contacts); the upsert hangs",
);
await step("demo", ["hs:seed", "--account", "demo", "--seed", "43"], "re-run settles the unknowns");
await step("demo", ["hs:seed", "--account", "eval", "--seed", "42"], "wrong key for the account");

await Promise.all(Object.values(fakes).map((f) => f.close()));
