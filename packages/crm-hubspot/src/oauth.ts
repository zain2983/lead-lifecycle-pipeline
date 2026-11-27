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
  const doFetch = input.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  });
  let response: Response;
  try {
    response = await doFetch(input.tokenUrl ?? HUBSPOT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  } catch (cause) {
    throw new HubSpotOAuthError("token request got no response", "unknown", undefined, undefined, {
      cause,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new HubSpotOAuthError(
      `token endpoint answered ${response.status}`,
      "rejected",
      response.status,
      text.slice(0, 2000),
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new HubSpotOAuthError(
      "token response is not JSON",
      "invalid_response",
      response.status,
      undefined,
      {
        cause,
      },
    );
  }
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Report which fields were wrong, never their values (they include the tokens).
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new HubSpotOAuthError(
      `token response has unexpected fields: ${fields}`,
      "invalid_response",
      response.status,
    );
  }
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
