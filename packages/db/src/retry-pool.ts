// A pg.Pool that tries again when a new connection is dropped before it is ready. About 1 in 27 new TLS
// connections from a laptop to Supabase's poolers are closed during connection setup
// (docs/evidence/phase-1/supabase-tls/README.md, "Dropped connections").
//
// Only getting a connection is retried. No statement has been sent at that point, so nothing can run twice.
// A statement that fails on an open connection is never retried.
import pg from "pg";

/** Pauses before the second and third attempts. */
export const CONNECT_RETRY_DELAYS_MS = [250, 1_000] as const;

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE"]);
// node-postgres gives these no code.
const TRANSIENT_MESSAGES = new Set([
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
]);

/**
 * Whether a failed connect is worth repeating. A server's answer (wrong password, too many connections), a
 * certificate error and a full pool's "timeout exceeded when trying to connect" are not.
 */
export function isTransientConnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code } = error as Error & { code?: string };
  return code ? TRANSIENT_CODES.has(code) : TRANSIENT_MESSAGES.has(error.message);
}

type ConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

export class RetryingPool extends pg.Pool {
  // `pool.query` gets its connection through this method too.
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | undefined {
    const client = this.connectWithRetry();
    if (!callback) return client;
    client.then(
      // Outside the promise chain, so an error thrown by the callback isn't reported as a connect failure.
      (connected) =>
        process.nextTick(callback, undefined, connected, (release?: unknown) =>
          connected.release(release as Error | boolean | undefined),
        ),
      (error: Error) => process.nextTick(callback, error, undefined, () => undefined),
    );
    return undefined;
  }

  private async connectWithRetry(): Promise<pg.PoolClient> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await super.connect();
      } catch (error) {
        const delay = CONNECT_RETRY_DELAYS_MS[attempt];
        if (delay === undefined || !isTransientConnectError(error)) throw error;
        // The code or fixed text only: other error messages can carry the server's address.
        const { code, message } = error as Error & { code?: string };
        console.warn(`[db] connection dropped during setup (${code ?? message}), retrying`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
