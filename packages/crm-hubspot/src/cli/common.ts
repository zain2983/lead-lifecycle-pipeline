import path from "node:path";
import { parseArgs } from "node:util";
import { EnvError, loadEnv } from "@repo/core";
import { HUBSPOT_API_BASE_URL, HubSpotClient } from "../api.ts";
import { ACCOUNTS, type Account } from "../seed.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/** Repo-root .env for local runs; variables already set (CI, tests) win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.join(repoRoot, ".env"));
  } catch {
    // No .env: the variables come from the environment.
  }
}

export function parseCli(
  usage: string,
  extra: Record<string, { type: "string" | "boolean"; default?: string | boolean }> = {},
) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      options: {
        account: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        ...extra,
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\nusage: ${usage}`);
    process.exit(64);
  }
  const account = parsed.values.account;
  if (typeof account !== "string" || !(ACCOUNTS as readonly string[]).includes(account)) {
    console.error(`--account must be one of ${ACCOUNTS.join(", ")}\nusage: ${usage}`);
    process.exit(64);
  }
  return { account: account as Account, values: parsed.values };
}

/** A client on the chosen account's service key. Only that account's key is read. */
export function clientFor(account: Account): { client: HubSpotClient; target: string } {
  try {
    return makeClient(account);
  } catch (error) {
    if (!(error instanceof EnvError)) throw error;
    console.error(`error     ${error.message}`);
    process.exit(1);
  }
}

function makeClient(account: Account): { client: HubSpotClient; target: string } {
  const env =
    account === "demo"
      ? {
          key: loadEnv(["hubspotServiceKeyDemo"]).HUBSPOT_SERVICE_KEY_DEMO,
          name: "HUBSPOT_SERVICE_KEY_DEMO",
        }
      : {
          key: loadEnv(["hubspotServiceKeyEval"]).HUBSPOT_SERVICE_KEY_EVAL,
          name: "HUBSPOT_SERVICE_KEY_EVAL",
        };
  const { HUBSPOT_API_BASE_URL: baseUrl } = loadEnv(["hubspotApi"]);
  const real = baseUrl.replace(/\/+$/, "") === HUBSPOT_API_BASE_URL;
  const client = new HubSpotClient({
    token: env.key,
    baseUrl,
    log: (line) => console.log(`  ... ${line}`),
  });
  const target = real
    ? `${baseUrl} (HubSpot), key ${env.name} (redacted)`
    : `${baseUrl} (NOT HubSpot: HUBSPOT_API_BASE_URL override), key ${env.name} (redacted)`;
  return { client, target };
}

export function exitCode(counts: Record<string, number>): number {
  if ((counts.failed ?? 0) > 0) return 1;
  if ((counts.unknown ?? 0) > 0) return 2;
  return 0;
}

export function countLine(counts: Record<string, number>): string {
  return ["created", "updated", "unchanged", "failed", "unknown"]
    .map((k) => `${k} ${counts[k] ?? 0}`)
    .join("  ");
}
