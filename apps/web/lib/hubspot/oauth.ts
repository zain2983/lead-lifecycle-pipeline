import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildAuthorizeUrl,
  type EncryptedSecret,
  encryptSecret,
  exchangeAuthorizationCode,
  HubSpotOAuthError,
  refreshTokenAad,
} from "@repo/crm-hubspot";

/**
 * OAuth install for the HubSpot app (Phase 1 minimal; Phase 3 adds refresh on expiry).
 *
 * GET /api/hubspot/oauth/start     sets a one-time `state` cookie and redirects to HubSpot's consent page.
 * GET /api/hubspot/oauth/callback  checks `state` against the cookie, exchanges the code at
 *                                  /oauth/v3/token and stores the refresh token encrypted.
 */

export const OAUTH_STATE_COOKIE = "hs_oauth_state";
const COOKIE_PATH = "/api/hubspot/oauth";
const STATE_TTL_SECONDS = 10 * 60;

export interface StoredOAuthToken {
  portalId: bigint;
  refreshToken: EncryptedSecret;
  scopes: string[];
  accessTokenExpiresAt: Date;
}

export interface OAuthTokenStore {
  save(token: StoredOAuthToken): Promise<void>;
}

export interface OAuthStartConfig {
  clientId: string;
  redirectUri: string;
  /** Tests pass a fixed state; production uses 32 random bytes. */
  state?: string;
}

export function startHubSpotOAuth(config: OAuthStartConfig): Response {
  const state = config.state ?? randomBytes(32).toString("base64url");
  const location = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "set-cookie": stateCookie(state, STATE_TTL_SECONDS, isHttps(config.redirectUri)),
      "cache-control": "no-store",
    },
  });
}

export interface OAuthCallbackConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenUrl: string;
  /** 32-byte key from TOKEN_ENCRYPTION_KEY. */
  encryptionKey: Uint8Array;
  store: OAuthTokenStore;
  fetch?: typeof fetch;
  now?: () => Date;
}

export async function completeHubSpotOAuth(
  request: Request,
  config: OAuthCallbackConfig,
): Promise<Response> {
  const url = new URL(request.url);
  // The state cookie is single-use: every answer from here clears it.
  const headers = {
    "set-cookie": stateCookie("", 0, isHttps(config.redirectUri)),
    "cache-control": "no-store",
  };
  const fail = (status: number, body: Record<string, unknown>) =>
    Response.json({ ok: false, ...body }, { status, headers });

  const hubspotError = url.searchParams.get("error");
  if (hubspotError) {
    return fail(400, {
      error: "authorization_failed",
      hubspot: {
        error: hubspotError,
        error_description: url.searchParams.get("error_description"),
      },
    });
  }

  const state = url.searchParams.get("state");
  const expected = readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
  if (!state || !expected) return fail(400, { error: "state_missing" });
  if (!sameString(state, expected)) return fail(400, { error: "state_mismatch" });

  const code = url.searchParams.get("code");
  if (!code) return fail(400, { error: "code_missing" });

  let tokens: Awaited<ReturnType<typeof exchangeAuthorizationCode>>;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      tokenUrl: config.tokenUrl,
      fetch: config.fetch,
      now: config.now,
    });
  } catch (error) {
    if (!(error instanceof HubSpotOAuthError)) throw error;
    console.warn(
      JSON.stringify({ msg: "hubspot token exchange", kind: error.kind, status: error.status }),
    );
    if (error.kind === "unknown") {
      return fail(504, {
        error: "token_exchange_unknown",
        detail:
          "No answer from the token endpoint. HubSpot may or may not have accepted the code; start the install again.",
      });
    }
    return fail(502, {
      error: "token_exchange_failed",
      detail: error.message,
      status: error.status,
      hubspot: parseJsonOrText(error.body),
    });
  }

  await config.store.save({
    portalId: tokens.portalId,
    refreshToken: encryptSecret(
      tokens.refreshToken,
      config.encryptionKey,
      refreshTokenAad(tokens.portalId),
    ),
    scopes: tokens.scopes,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
  });
  console.info(JSON.stringify({ msg: "hubspot installed", portalId: tokens.portalId.toString() }));

  // Never echo a token. The access token is dropped here; Phase 3 refreshes on demand.
  return Response.json(
    {
      ok: true,
      portalId: tokens.portalId.toString(),
      scopes: tokens.scopes,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    },
    { status: 200, headers },
  );
}

function stateCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  // SameSite=Lax so the cookie comes back on HubSpot's top-level redirect to the callback.
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || undefined;
  }
  return undefined;
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function isHttps(url: string): boolean {
  return new URL(url).protocol === "https:";
}

function parseJsonOrText(body: string | undefined): unknown {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
