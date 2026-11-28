import { type HubSpotAuth, HubSpotClient, type HubSpotClientOptions } from "./api.ts";
import { HubSpotOAuthError, oauthErrorCodes, refreshAccessToken } from "./oauth.ts";
import { decryptSecret, encryptSecret, refreshTokenAad } from "./token-crypto.ts";
import type { OAuthTokenStore, RefreshFailure } from "./token-store.ts";

/**
 * Access tokens for OAuth-installed portals (PLAN Phase 3.1).
 *
 * - The access token lives in memory only, per portal, and is refreshed `safetyMarginMs` before HubSpot's
 *   `expires_in` runs out (default 5 minutes of the documented 1,800 s; at most half the lifetime, so a
 *   short-lived token isn't refreshed on every call).
 * - **Single-flight per portal:** concurrent callers share one refresh request. This is per process;
 *   two processes may each refresh, which HubSpot allows (each gets its own access token).
 * - If HubSpot answers with a refresh token different from the stored one, the new one is encrypted and
 *   stored before the access token is used. UNVERIFIED (live check pending): whether HubSpot ever
 *   rotates refresh tokens; the docs don't say.
 * - A refresh with no answer is `HubSpotOAuthError` kind `unknown`, recorded as such and never cached. A
 *   rejection (e.g. 400 BAD_REFRESH_TOKEN after an uninstall) is kind `rejected`. Both are recorded on the
 *   row without any token, and the next call tries again.
 */

export class HubSpotNotInstalledError extends Error {
  override name = "HubSpotNotInstalledError";
  constructor(readonly portalId: bigint) {
    super(`no HubSpot install stored for portal ${portalId}`);
  }
}

export interface TokenManagerOptions {
  clientId: string;
  clientSecret: string;
  /** Default https://api.hubapi.com/oauth/v3/token. */
  tokenUrl?: string;
  /** TOKEN_ENCRYPTION_KEY, decoded (32 bytes). */
  encryptionKey: Uint8Array;
  store: OAuthTokenStore;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  safetyMarginMs?: number;
  /** One structured line per refresh or failure (no tokens). */
  log?: (event: Record<string, unknown>) => void;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  refreshAt: number;
}

export const DEFAULT_SAFETY_MARGIN_MS = 5 * 60_000;

export class HubSpotTokenManager {
  readonly stats = { refreshes: 0, cacheHits: 0 };
  readonly #options: TokenManagerOptions;
  readonly #now: () => Date;
  readonly #cache = new Map<string, CachedToken>();
  readonly #inflight = new Map<string, Promise<string>>();

  constructor(options: TokenManagerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async getAccessToken(portalId: bigint): Promise<string> {
    const key = portalId.toString();
    const cached = this.#cache.get(key);
    if (cached && this.#now().getTime() < cached.refreshAt) {
      this.stats.cacheHits++;
      return cached.accessToken;
    }
    let flight = this.#inflight.get(key);
    if (!flight) {
      flight = this.#refresh(portalId).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, flight);
    }
    return flight;
  }

  /**
   * Forget the cached token after HubSpot refused it (401), so the next call refreshes. Only drops the
   * cache if it still holds the token that failed (another caller may already have refreshed).
   */
  invalidate(portalId: bigint, failedToken?: string): void {
    const key = portalId.toString();
    const cached = this.#cache.get(key);
    if (cached && (failedToken === undefined || cached.accessToken === failedToken)) {
      this.#cache.delete(key);
    }
  }

  /** `auth` for a `HubSpotClient` acting for this portal. */
  authFor(portalId: bigint): HubSpotAuth {
    return {
      type: "oauth",
      getAccessToken: () => this.getAccessToken(portalId),
      invalidate: (failedToken) => this.invalidate(portalId, failedToken),
    };
  }

  /** A REST client that authenticates as this portal's OAuth install. */
  clientFor(
    portalId: bigint,
    options: Omit<HubSpotClientOptions, "token" | "auth"> = {},
  ): HubSpotClient {
    return new HubSpotClient({ ...options, auth: this.authFor(portalId) });
  }

  async #refresh(portalId: bigint): Promise<string> {
    const { store, encryptionKey } = this.#options;
    const stored = await store.load(portalId);
    if (!stored) throw new HubSpotNotInstalledError(portalId);
    const aad = refreshTokenAad(portalId);
    const refreshToken = decryptSecret(stored.refreshToken, encryptionKey, aad);
    const at = this.#now();
    this.stats.refreshes++;

    let result: Awaited<ReturnType<typeof refreshAccessToken>>;
    try {
      result = await refreshAccessToken({
        refreshToken,
        clientId: this.#options.clientId,
        clientSecret: this.#options.clientSecret,
        tokenUrl: this.#options.tokenUrl,
        fetch: this.#options.fetch,
        now: () => at,
        timeoutMs: this.#options.timeoutMs,
      });
    } catch (error) {
      if (error instanceof HubSpotOAuthError) await this.#recordFailure(portalId, at, error);
      throw error;
    }

    if (result.portalId !== undefined && result.portalId !== portalId) {
      const error = new HubSpotOAuthError(
        `token endpoint answered for portal ${result.portalId}, not ${portalId}`,
        "invalid_response",
      );
      await this.#recordFailure(portalId, at, error);
      throw error;
    }

    const rotated = result.refreshToken !== undefined && result.refreshToken !== refreshToken;
    // Store first: if HubSpot did rotate the token and this write fails, the caller must not carry on
    // as if nothing happened.
    await store.recordRefresh(portalId, {
      at,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      ...(result.scopes ? { scopes: result.scopes } : {}),
      ...(rotated && result.refreshToken
        ? { rotatedRefreshToken: encryptSecret(result.refreshToken, encryptionKey, aad) }
        : {}),
    });

    const lifetime = result.expiresInSeconds * 1000;
    const margin = Math.min(this.#options.safetyMarginMs ?? DEFAULT_SAFETY_MARGIN_MS, lifetime / 2);
    const expiresAt = at.getTime() + lifetime;
    this.#cache.set(portalId.toString(), {
      accessToken: result.accessToken,
      expiresAt,
      refreshAt: expiresAt - margin,
    });
    this.#options.log?.({
      msg: "hubspot token refreshed",
      portalId: portalId.toString(),
      expiresInSeconds: result.expiresInSeconds,
      refreshTokenRotated: rotated,
    });
    return result.accessToken;
  }

  async #recordFailure(portalId: bigint, at: Date, error: HubSpotOAuthError): Promise<void> {
    const codes = oauthErrorCodes(error.body);
    const failure: RefreshFailure = {
      at,
      kind: error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(codes.status ? { hubspotStatus: codes.status } : {}),
      ...(codes.error ? { error: codes.error } : {}),
      message: error.message,
    };
    this.#options.log?.({
      msg: "hubspot token refresh failed",
      portalId: portalId.toString(),
      ...failure,
      at: at.toISOString(),
    });
    try {
      await this.#options.store.recordRefreshFailure(portalId, failure);
    } catch (storeError) {
      // The refresh error is what the caller needs; a failed bookkeeping write must not replace it.
      this.#options.log?.({
        msg: "hubspot token refresh failure not recorded",
        portalId: portalId.toString(),
        error: String(storeError),
      });
    }
  }
}
