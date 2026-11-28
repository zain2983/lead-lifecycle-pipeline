// loadRootEnvFile lives at @repo/core/dotenv: it walks the filesystem, so app bundles must not import it.
export { type Env, EnvError, type EnvGroup, envGroups, loadEnv } from "./env.ts";
export { deterministicJobId, ID_NAMESPACE, uuidV5 } from "./ids.ts";
export { isReservedEmail, RESERVED_EMAIL } from "./reserved.ts";
