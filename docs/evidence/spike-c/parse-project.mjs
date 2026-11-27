// Offline check of integrations/hubspot-app/dev with the HubSpot CLI's own parser
// (@hubspot/project-parsing-lib, the version @hubspot/cli 8.19.0 depends on).
// It parses hsproject.json and every *-hsmeta.json into the intermediate representation that
// `hs project upload` sends. Schema validation is skipped: the CLI downloads the schemas from
// HubSpot per account, so it needs `hs account auth` (Blocked on Zain).
// Usage: node docs/evidence/spike-c/parse-project.mjs <path to @hubspot/project-parsing-lib>
import path from "node:path";
import { pathToFileURL } from "node:url";

const lib = process.argv[2];
const projectDir = path.resolve(import.meta.dirname, "../../../integrations/hubspot-app/dev");
const load = (p) => import(pathToFileURL(path.join(lib, p)).href);
const { parseProjectConfig, validateProjectConfig, isKnownPlatformVersion } =
  await load("src/exports/projects.js");
const { translate } = await load("src/exports/translate.js");

const parsed = parseProjectConfig(projectDir);
console.log("parseProjectConfig:", JSON.stringify(parsed, null, 2));
try {
  validateProjectConfig(parsed.projectConfig ?? parsed, parsed.projectDir ?? projectDir);
  console.log("validateProjectConfig: ok");
} catch (error) {
  console.log("validateProjectConfig: FAILED", error.message);
}
const config = parsed.projectConfig ?? parsed;
console.log(
  "isKnownPlatformVersion(%s):",
  config.platformVersion,
  isKnownPlatformVersion(config.platformVersion),
);
const result = await translate(
  {
    projectSourceDir: path.join(projectDir, config.srcDir),
    platformVersion: config.platformVersion,
  },
  { skipValidation: true },
);
console.log("translate (skipValidation):", JSON.stringify(result, null, 2));
