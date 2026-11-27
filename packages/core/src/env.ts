import { z } from "zod";

/**
 * Environment variables, validated with zod. Every runtime parses only the groups it needs, and fails fast
 * at start-up with a readable list of what is missing. See `.env.example` for which runtime needs which group.
 */

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string");

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
  hubspot: z.object({
    HUBSPOT_CLIENT_ID: z.string().min(1),
    HUBSPOT_CLIENT_SECRET: z.string().min(1),
    /** The exact URL HubSpot calls. Signature v3 is checked against this, never against the Host header. */
    PUBLIC_WEBHOOK_URL: z.url(),
    /** 32 bytes, base64. Encrypts the stored OAuth refresh token (AES-256-GCM). */
    TOKEN_ENCRYPTION_KEY: z.base64().refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "must decode to exactly 32 bytes",
    }),
  }),
  hubspotServiceKeys: z.object({
    HUBSPOT_SERVICE_KEY_DEMO: z.string().min(1),
    HUBSPOT_SERVICE_KEY_EVAL: z.string().min(1),
  }),
  sim: z.object({
    SIM_BASE_URL: z.url().default("http://localhost:3000"),
    SIM_API_KEY: z.string().min(1),
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
