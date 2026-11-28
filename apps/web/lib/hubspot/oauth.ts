import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildAuthorizeUrl,
  encryptSecret,
  exchangeAuthorizationCode,
  HubSpotOAuthError,
  type InstallSource,
  type OAuthTokenStore,
  refreshTokenAad,
} from "@repo/crm-hubspot";

export type { StoredOAuthToken } from "@repo/crm-hubspot";

/**
 * OAuth install for the HubSpot app. The worker refreshes access tokens (HubSpotTokenManager); this file
 * only installs.
 *
 * GET /api/hubspot/oauth/start     sets a one-time `state` cookie and redirects to HubSpot's consent page.
 * GET /api/hubspot/oauth/callback  checks `state` against the cookie, exchanges the code at
 *                                  /oauth/v3/token and stores the refresh token encrypted.
 *
 * A callback with **no `state` parameter at all** came from HubSpot's own Install button (or a test
 * install), which sends none. docs/adr/0006-hubspot-initiated-installs.md: it is accepted only for a
 * portal that is already known (HUBSPOT_KNOWN_PORTAL_IDS, or an install stored earlier), which needs the
 * code exchanged first, since only the token response names the portal. For any other portal the tokens
 * are dropped unstored and the browser gets a page that says what to do. A `state` that is present but
 * empty, wrong or without its cookie is still refused before any exchange.
 */

export const OAUTH_STATE_COOKIE = "hs_oauth_state";
const COOKIE_PATH = "/api/hubspot/oauth";
const STATE_TTL_SECONDS = 10 * 60;

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
  store: Pick<OAuthTokenStore, "save" | "load">;
  /** HUBSPOT_KNOWN_PORTAL_IDS: portals that may install without our state. */
  knownPortalIds?: readonly bigint[];
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
  const installedVia: InstallSource = state === null ? "hubspot_initiated" : "app_start";
  if (state !== null) {
    const expected = readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE);
    if (!state || !expected) return fail(400, { error: "state_missing" });
    if (!sameString(state, expected)) return fail(400, { error: "state_mismatch" });
  }

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

  if (installedVia === "hubspot_initiated") {
    const known =
      (config.knownPortalIds ?? []).includes(tokens.portalId) ||
      (await config.store.load(tokens.portalId)) !== null;
    if (!known) {
      // The tokens are dropped here, unstored; the access token expires on its own.
      console.warn(
        JSON.stringify({
          msg: "hubspot install rejected",
          reason: "unknown_portal",
          portalId: tokens.portalId.toString(),
        }),
      );
      return rejectionPage(tokens.portalId, headers);
    }
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
    installedVia,
  });
  console.info(
    JSON.stringify({
      msg: "hubspot installed",
      portalId: tokens.portalId.toString(),
      installedVia,
    }),
  );

  // Never echo a token. The access token is dropped here; Phase 3 refreshes on demand.
  return Response.json(
    {
      ok: true,
      portalId: tokens.portalId.toString(),
      scopes: tokens.scopes,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      ...(installedVia === "hubspot_initiated" ? { installedVia } : {}),
    },
    { status: 200, headers },
  );
}

/** 403 for a HubSpot-initiated install into a portal this deployment doesn't know. */
function rejectionPage(portalId: bigint, headers: Record<string, string>): Response {
  const id = portalId.toString(); // digits only: safe in HTML
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Install not accepted</title></head>
<body data-error="unknown_portal" style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5">
<h1>Install not accepted</h1>
<p>HubSpot account <strong>${id}</strong> started this install from HubSpot's own Install button, and this
deployment doesn't know that account, so nothing was stored.</p>
<ul>
<li>To install from here instead: <a href="/api/hubspot/oauth/start">start the install</a>.</li>
<li>To accept installs from that button for this account: add <code>${id}</code> to
<code>HUBSPOT_KNOWN_PORTAL_IDS</code>, then install again.</li>
</ul>
<p>HubSpot may still list the app as installed in that account; uninstall it there if it shouldn't be.</p>
</body>
</html>
`;
  return new Response(html, {
    status: 403,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
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
