import { z } from "zod";

/**
 * Environment variables, validated with zod. Every runtime parses only the groups it needs, and fails fast
 * at start-up with a readable list of what is missing. See `.env.example` for which runtime needs which group.
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string");

/** HubSpot webhook receiver (web) and `pnpm hs:replay`: just what signature v3 needs. */
const hubspotWebhook = z.object({
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  /** The exact URL HubSpot calls. Signature v3 is checked against this, never against the Host header. */
  PUBLIC_WEBHOOK_URL: z.url(),
  /**
   * Local live tests only: an absolute directory outside the repo where every delivery is written as
   * received (headers, raw body, verdict). Never set on Vercel.
   */
  HUBSPOT_WEBHOOK_CAPTURE_DIR: z.string().min(1).optional(),
});

/** Token refresh (local worker, Actions): what the refresh grant and the stored token need. */
const hubspotTokenRefresh = z.object({
  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  /** Optional override of HubSpot's token endpoint, for offline tests against a local fake. */
  HUBSPOT_OAUTH_TOKEN_URL: z.url().default("https://api.hubapi.com/oauth/v3/token"),
  /** 32 bytes, base64. Encrypts the stored OAuth refresh token (AES-256-GCM). */
  TOKEN_ENCRYPTION_KEY: z.base64().refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "must decode to exactly 32 bytes",
  }),
});

/**
 * HubSpot portal IDs (comma-separated) whose installs may start from HubSpot's own Install button,
 * without our `state`. Empty or unset: only installs started at /api/hubspot/oauth/start are accepted
 * (docs/adr/0006-hubspot-initiated-installs.md).
 */
const knownPortalIds = z
  .string()
  .optional()
  .transform((value, ctx) => {
    const ids = (value ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const id of ids) {
      if (!/^[1-9]\d{0,18}$/.test(id)) {
        ctx.addIssue({ code: "custom", message: `not a portal ID: ${id}` });
        return z.NEVER;
      }
    }
    return ids.map((id) => BigInt(id));
  });

/** OAuth install and token refresh (web). */
const hubspotOAuth = hubspotTokenRefresh.extend({
  /**
   * Sent as `redirect_uri` to the authorize URL and again to the token endpoint, so it must be one of the
   * app's `redirectUrls` exactly: http://localhost:3100/api/hubspot/oauth/callback locally.
   */
  HUBSPOT_REDIRECT_URI: z.url(),
  HUBSPOT_KNOWN_PORTAL_IDS: knownPortalIds,
});

export const envGroups = {
  /** Runtime connection (Vercel, local worker): the transaction pooler in production. */
  database: z.object({
    DATABASE_URL: postgresUrl,
  }),
  /** CLI, migrations and long-running workers: the session pooler in production. */
  databaseDirect: z.object({
    DIRECT_URL: postgresUrl,
  }),
  app: z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PUBLIC_BASE_URL: z.url(),
  }),
  hubspotWebhook,
  hubspotOAuth,
  hubspotTokenRefresh,
  /** Everything above: the web app as a whole. */
  hubspot: hubspotWebhook.extend(hubspotOAuth.shape),
  /** Both test accounts' service keys (the daily `hs:ping` keep-alive). */
  hubspotServiceKeys: z.object({
    HUBSPOT_SERVICE_KEY_DEMO: z.string().min(1),
    HUBSPOT_SERVICE_KEY_EVAL: z.string().min(1),
  }),
  /** One account at a time: `pnpm hs:setup` / `hs:seed --account demo|eval`. */
  hubspotServiceKeyDemo: z.object({ HUBSPOT_SERVICE_KEY_DEMO: z.string().min(1) }),
  hubspotServiceKeyEval: z.object({ HUBSPOT_SERVICE_KEY_EVAL: z.string().min(1) }),
  /** HubSpot's REST API. Override only to point a CLI at a local fake (tests, offline evidence). */
  hubspotApi: z.object({
    HUBSPOT_API_BASE_URL: z.url().default("https://api.hubapi.com"),
  }),
  /** The local Sim instance. Only the local worker talks to it (ADR 0003). */
  sim: z.object({
    SIM_BASE_URL: z.url().default("http://localhost:3000"),
    /** A personal API key: saving workflow source and running a pinned version need one. */
    SIM_API_KEY: z.string().min(1),
    /** Listing paused runs (GET /api/v2/workflows/runs/paused) needs the workspace. */
    SIM_WORKSPACE_ID: z.string().min(1),
  }),
  simTriage: z.object({
    SIM_TRIAGE_WORKFLOW_ID: z.string().min(1),
  }),
  simApprovals: z.object({
    /** Shared secret the Human block's notification webhook sends to /api/sim/approvals. */
    SIM_APPROVAL_SECRET: z.string().min(24),
  }),
  /** Spike-only routes under /api/spikes/*. On only when exactly "1"; anything else, or unset, is off. */
  spikes: z.object({
    SPIKE_ROUTES: z
      .string()
      .optional()
      .transform((value) => value === "1"),
  }),
} as const;

export type EnvGroup = keyof typeof envGroups;

type Shape<G extends EnvGroup> = z.infer<(typeof envGroups)[G]>;
type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;
export type Env<G extends EnvGroup> = UnionToIntersection<Shape<G>>;

export class EnvError extends Error {
  override name = "EnvError";
}

/**
 * Parse the named groups from `source` (default `process.env`). Throws `EnvError` listing every problem
 * at once, so a misconfigured deploy fails at start-up rather than at the first request.
 */
export function loadEnv<const G extends EnvGroup>(
  groups: readonly G[],
  source: Record<string, string | undefined> = process.env,
): Env<G> {
  let schema = z.object({});
  for (const group of groups) {
    schema = schema.extend(envGroups[group].shape);
  }
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(
      `Invalid environment for [${groups.join(", ")}]:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data as Env<G>;
}
