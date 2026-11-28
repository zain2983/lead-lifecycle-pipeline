/**
 * A small HubSpot REST client for one account, authenticated either with that account's **service key**
 * (`hs:setup`, `hs:seed`) or with an **OAuth access token** of the installed app (the worker, Phase 3;
 * see token-manager.ts). Both are sent as `Authorization: Bearer`.
 *
 * With OAuth, a 401 drops the cached access token and the request is sent once more with a fresh one (a
 * 401 is refused before processing, so this is safe for writes). UNVERIFIED (live check pending): the
 * body HubSpot sends with a 401 for an expired token; the code relies on the status only.
 *
 * Paths use the date-versioned API, `/crm/{api}/2026-09/...`, which HubSpot marks GA since 2026-09-08 and
 * shows on its "latest" reference pages; the `/crm/v3/...` paths are listed as legacy.
 *
 * Rate limits (https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines, read
 * 2026-11-28). Service keys get the limits of privately distributed apps:
 * - per 10 seconds, per app: 100 on Free and Starter, 190 on Professional and Enterprise;
 * - per day, per account: 250,000 / 625,000 / 1,000,000.
 * The docs don't say which tier a developer test account counts as, so the limiter assumes the lowest
 * (100 per 10 s) and uses half of it. A 429 carries `policyName` (`TEN_SECONDLY_ROLLING` or `DAILY`) and
 * no documented `Retry-After`; responses carry `X-HubSpot-RateLimit-Remaining` and
 * `-Interval-Milliseconds`. 423 Locked means "wait at least 2 seconds"
 * (https://developers.hubspot.com/docs/api-reference/error-handling).
 *
 * Outcomes are never guessed:
 * - a 429 or 423 was refused before processing, so it is retried with capped exponential backoff and jitter;
 * - a timeout, dropped connection or 5xx on a **write** may or may not have been applied, so it throws
 *   `HubSpotOutcomeUnknownError` and is never retried (the CLIs report it as `unknown`; re-running is safe
 *   because both CLIs read before they write);
 * - the same on a **read** is retried, then thrown;
 * - any other status throws `HubSpotApiError` with HubSpot's body exactly as it came back.
 */

export const HUBSPOT_API_BASE_URL = "https://api.hubapi.com";
export const HUBSPOT_API_VERSION = "2026-09";

/** Half of the lowest documented burst limit (100 requests per 10 s). */
export const DEFAULT_RATE_LIMIT = { maxRequests: 50, windowMs: 10_000 } as const;

export class HubSpotApiError extends Error {
  override name = "HubSpotApiError";
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    /** HubSpot's response body, exactly as received (truncated to 4 kB). */
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }

  /** HubSpot's `category` (e.g. `VALIDATION_ERROR`, `OBJECT_NOT_FOUND`), when the body is JSON. */
  get category(): string | undefined {
    try {
      const parsed = JSON.parse(this.body) as { category?: unknown };
      return typeof parsed.category === "string" ? parsed.category : undefined;
    } catch {
      return undefined;
    }
  }
}

/** No usable answer to a write: HubSpot may or may not have applied it. */
export class HubSpotOutcomeUnknownError extends Error {
  override name = "HubSpotOutcomeUnknownError";
  readonly outcome = "unknown" as const;
  constructor(
    readonly method: string,
    readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`${method} ${path}: outcome unknown (${reason})`, options);
  }
}

export interface HubSpotResponse<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface HubSpotRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
  /**
   * True for reads, including POST `batch/read`. Only these are retried after a timeout or 5xx.
   * Defaults to true for GET and false otherwise.
   */
  idempotentRead?: boolean;
}

/** How a request authenticates. Neither the key nor the token is ever logged. */
export type HubSpotAuth =
  | { type: "service_key"; key: string }
  | {
      type: "oauth";
      getAccessToken: () => Promise<string>;
      /** Called with the token HubSpot answered 401 to. */
      invalidate: (failedToken: string) => void;
    };

export interface HubSpotClientOptions {
  /** The account's service key (shorthand for `auth: { type: "service_key", key }`). */
  token?: string;
  auth?: HubSpotAuth;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  rateLimit?: { maxRequests: number; windowMs: number };
  /** Retries after a 429/423 (any request) or a timeout/5xx (reads only). */
  maxRetries?: number;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** One line per retry or wait, for the CLI's output. */
  log?: (line: string) => void;
}

export interface ClientStats {
  requests: number;
  retries: number;
  rateLimitWaits: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HubSpotClient {
  readonly baseUrl: string;
  readonly stats: ClientStats = { requests: 0, retries: 0, rateLimitWaits: 0 };
  readonly #auth: HubSpotAuth;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #rateLimit: { maxRequests: number; windowMs: number };
  readonly #maxRetries: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #log: (line: string) => void;
  /** Send times inside the current window (sliding-window limiter). */
  readonly #sent: number[] = [];
  /** Set from HubSpot's headers when it says the window is used up. */
  #blockedUntil = 0;

  constructor(options: HubSpotClientOptions) {
    const auth =
      options.auth ?? (options.token ? { type: "service_key" as const, key: options.token } : null);
    if (!auth || (auth.type === "service_key" && !auth.key)) {
      throw new TypeError("HubSpotClient: empty token");
    }
    this.#auth = auth;
    this.baseUrl = (options.baseUrl ?? HUBSPOT_API_BASE_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.#maxRetries = options.maxRetries ?? 5;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? realSleep;
    this.#random = options.random ?? Math.random;
    this.#log = options.log ?? (() => {});
  }

  async request<T = unknown>(init: HubSpotRequest): Promise<HubSpotResponse<T>> {
    const read = init.idempotentRead ?? init.method === "GET";
    let reauthorized = false;
    for (let attempt = 0; ; attempt++) {
      await this.#acquire();
      const bearer =
        this.#auth.type === "service_key" ? this.#auth.key : await this.#auth.getAccessToken();
      this.stats.requests++;
      let response: Response;
      try {
        response = await this.#fetch(`${this.baseUrl}${init.path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer ${bearer}`,
            accept: "application/json",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        const reason = isTimeout(cause)
          ? `no response within ${this.#timeoutMs} ms`
          : "no response";
        if (!read) throw new HubSpotOutcomeUnknownError(init.method, init.path, reason, { cause });
        if (attempt >= this.#maxRetries) {
          throw new HubSpotOutcomeUnknownError(
            init.method,
            init.path,
            `${reason}, retries used up`,
            {
              cause,
            },
          );
        }
        await this.#backoff(attempt, `${init.method} ${init.path}: ${reason}`);
        continue;
      }

      this.#noteRateLimitHeaders(response.headers);
      const text = await response.text();
      if (response.ok) {
        return { status: response.status, body: parseJson(text) as T, headers: response.headers };
      }
      const status = response.status;
      if (status === 401 && this.#auth.type === "oauth" && !reauthorized) {
        reauthorized = true;
        this.#auth.invalidate(bearer);
        this.#log(`${init.method} ${init.path}: 401, retrying once with a fresh access token`);
        continue;
      }
      if (status === 429) {
        if (/"policyName"\s*:\s*"DAILY"/i.test(text)) {
          throw new HubSpotApiError(init.method, init.path, status, text.slice(0, 4096));
        }
        if (attempt >= this.#maxRetries) {
          throw new HubSpotApiError(init.method, init.path, status, text.slice(0, 4096));
        }
        await this.#backoff(attempt, `${init.method} ${init.path}: 429 ${policyName(text)}`);
        continue;
      }
      if (status === 423 && attempt < this.#maxRetries) {
        await this.#backoff(attempt, `${init.method} ${init.path}: 423 Locked`, 2_000);
        continue;
      }
      if (status >= 500) {
        if (!read) {
          throw new HubSpotOutcomeUnknownError(
            init.method,
            init.path,
            `HubSpot answered ${status}: ${text.slice(0, 200)}`,
          );
        }
        if (attempt < this.#maxRetries) {
          await this.#backoff(attempt, `${init.method} ${init.path}: ${status}`);
          continue;
        }
      }
      throw new HubSpotApiError(init.method, init.path, status, text.slice(0, 4096));
    }
  }

  /** Wait until the sliding window has room, and past any block HubSpot's headers announced. */
  async #acquire(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#sent.length > 0 && (this.#sent[0] ?? 0) <= now - this.#rateLimit.windowMs) {
        this.#sent.shift();
      }
      const blockedFor = this.#blockedUntil - now;
      const windowFull = this.#sent.length >= this.#rateLimit.maxRequests;
      if (blockedFor <= 0 && !windowFull) {
        this.#sent.push(now);
        return;
      }
      const wait = Math.max(
        blockedFor,
        windowFull ? (this.#sent[0] ?? now) + this.#rateLimit.windowMs - now : 0,
        1,
      );
      this.stats.rateLimitWaits++;
      this.#log(`rate limit: waiting ${wait} ms`);
      await this.#sleep(wait);
    }
  }

  #noteRateLimitHeaders(headers: Headers): void {
    const remaining = Number(headers.get("x-hubspot-ratelimit-remaining") ?? Number.NaN);
    const interval = Number(headers.get("x-hubspot-ratelimit-interval-milliseconds") ?? Number.NaN);
    if (remaining === 0 && Number.isFinite(interval)) {
      this.#blockedUntil = Math.max(this.#blockedUntil, this.#now() + interval);
    }
  }

  async #backoff(attempt: number, what: string, floorMs = 0): Promise<void> {
    const base = Math.min(500 * 2 ** attempt, 10_000);
    const wait = Math.max(floorMs, Math.round(base / 2 + this.#random() * (base / 2)));
    this.stats.retries++;
    this.#log(`${what}; retry ${attempt + 1}/${this.#maxRetries} in ${wait} ms`);
    await this.#sleep(wait);
  }
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function parseJson(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function policyName(text: string): string {
  return /"policyName"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? "";
}
