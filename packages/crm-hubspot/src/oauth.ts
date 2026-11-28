import { z } from "zod";

/**
 * HubSpot OAuth 2.0 authorization-code flow for developer-platform apps.
 * Docs: https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide
 * The token endpoint is `/oauth/v3/token`; the v1 endpoints are deprecated.
 */

export const HUBSPOT_AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
export const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";

/**
 * Must match `auth.requiredScopes` in `integrations/hubspot-app/dev/src/app/app-hsmeta.json`
 * (a test checks this). HubSpot rejects an install whose `scope` differs from the app's required scopes.
 */
export const HUBSPOT_REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.schemas.contacts.read",
  "crm.schemas.contacts.write",
  "crm.objects.deals.read",
  "crm.objects.deals.write",
] as const;

export interface AuthorizeUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  authorizeUrl?: string;
}

/** Scopes are separated by `%20` (HubSpot's docs), not `+` as `URLSearchParams` would write them. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const params: [string, string][] = [
    ["client_id", input.clientId],
    ["scope", (input.scopes ?? HUBSPOT_REQUIRED_SCOPES).join(" ")],
    ["redirect_uri", input.redirectUri],
    ["state", input.state],
  ];
  const query = params.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&");
  return `${input.authorizeUrl ?? HUBSPOT_AUTHORIZE_URL}?${query}`;
}

/** The documented v3 token response. `hub_id` identifies the installing account (the portal ID). */
const tokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  hub_id: z.number().int().positive(),
  scopes: z.array(z.string()),
});

export interface HubSpotTokens {
  portalId: bigint;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  scopes: string[];
  tokenType: string;
}

/**
 * `status` is HubSpot's HTTP status when there was one. `body` is HubSpot's error body exactly as it came
 * back (it never contains our secret or the code's tokens).
 */
export class HubSpotOAuthError extends Error {
  override name = "HubSpotOAuthError";
  constructor(
    message: string,
    readonly kind: "rejected" | "invalid_response" | "unknown",
    readonly status?: number,
    readonly body?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** HubSpot's `status` (e.g. `BAD_REFRESH_TOKEN`) and `error` (e.g. `invalid_grant`) from an error body. */
export function oauthErrorCodes(body: string | undefined): { status?: string; error?: string } {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { status?: unknown; error?: unknown };
    return {
      ...(typeof parsed.status === "string" ? { status: parsed.status } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return {};
  }
}

interface TokenRequest {
  form: Record<string, string>;
  tokenUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * POST a form to the token endpoint and return the parsed JSON. A timeout or network failure is
 * `kind: "unknown"`: HubSpot may have answered, so the caller must report neither success nor failure.
 */
async function postTokenForm(request: TokenRequest): Promise<{ status: number; json: unknown }> {
  const doFetch = request.fetch ?? fetch;
  let response: Response;
  let text: string;
  try {
    response = await doFetch(request.tokenUrl ?? HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(request.form),
      signal: AbortSignal.timeout(request.timeoutMs ?? 10_000),
    });
    text = await response.text();
  } catch (cause) {
    throw new HubSpotOAuthError("token request got no response", "unknown", undefined, undefined, {
      cause,
    });
  }
  if (!response.ok) {
    throw new HubSpotOAuthError(
      `token endpoint answered ${response.status}`,
      "rejected",
      response.status,
      text.slice(0, 2000),
    );
  }
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch (cause) {
    throw new HubSpotOAuthError(
      "token response is not JSON",
      "invalid_response",
      response.status,
      undefined,
      { cause },
    );
  }
}

/** Report which fields were wrong, never their values (they include the tokens). */
function invalidFields(issues: readonly z.core.$ZodIssue[], status: number): HubSpotOAuthError {
  const fields = issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
  return new HubSpotOAuthError(
    `token response has unexpected fields: ${fields}`,
    "invalid_response",
    status,
  );
}

export interface ExchangeCodeInput {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Exchange an authorization code for tokens. A timeout or network failure is `kind: "unknown"`: HubSpot
 * may have accepted (and spent) the code, so the caller must not report it as failed or as installed.
 */
export async function exchangeAuthorizationCode(input: ExchangeCodeInput): Promise<HubSpotTokens> {
  const { status, json } = await postTokenForm({
    form: {
      grant_type: "authorization_code",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    },
    tokenUrl: input.tokenUrl,
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) throw invalidFields(parsed.error.issues, status);
  const tokens = parsed.data;
  const now = input.now?.() ?? new Date();
  return {
    portalId: BigInt(tokens.hub_id),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    scopes: tokens.scopes,
    tokenType: tokens.token_type,
  };
}

/**
 * The refresh grant's answer. The docs show one example body for both grants ("The body of the token
 * response will resemble the following"), with `refresh_token`, `hub_id` and `scopes`.
 * UNVERIFIED (live check pending): that a refresh answer carries `hub_id`, `scopes` and `refresh_token`
 * too, and whether `refresh_token` ever differs from the one sent. All three are optional here: a
 * missing one is not an error, and a different refresh token is stored (see token-manager.ts).
 */
const refreshResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  hub_id: z.number().int().positive().optional(),
  scopes: z.array(z.string()).optional(),
});

export interface RefreshedAccessToken {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Seconds, as HubSpot sent it (`expires_in`). */
  expiresInSeconds: number;
  /** Present only if HubSpot sent one. */
  refreshToken?: string;
  portalId?: bigint;
  scopes?: string[];
}

export interface RefreshTokenInput {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * The refresh grant on `/oauth/v3/token`: `grant_type=refresh_token`, `client_id`, `client_secret`,
 * `refresh_token` (https://developers.hubspot.com/docs/api-reference/legacy/authentication/manage-oauth-tokens,
 * read 2026-11-28; the quickstart's sample also sends `redirect_uri`, the reference doesn't list it).
 *
 * HubSpot's documented error for a revoked or expired refresh token is a 4xx with
 * `{"error":"invalid_grant","status":"BAD_REFRESH_TOKEN",…}`: that is `kind: "rejected"`, and
 * `oauthErrorCodes(error.body)` gives the codes. No answer is `kind: "unknown"`.
 */
export async function refreshAccessToken(input: RefreshTokenInput): Promise<RefreshedAccessToken> {
  const { status, json } = await postTokenForm({
    form: {
      grant_type: "refresh_token",
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
    },
    tokenUrl: input.tokenUrl,
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const parsed = refreshResponseSchema.safeParse(json);
  if (!parsed.success) throw invalidFields(parsed.error.issues, status);
  const tokens = parsed.data;
  const now = input.now?.() ?? new Date();
  return {
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    expiresInSeconds: tokens.expires_in,
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    ...(tokens.hub_id === undefined ? {} : { portalId: BigInt(tokens.hub_id) }),
    ...(tokens.scopes === undefined ? {} : { scopes: tokens.scopes }),
  };
}
