# TLS to Supabase (ADR 0007)

Produced on 2026-11-28 from a Mac (macOS 26.5.1, arm64, Node 26.5) and Linux containers on it, against the hosted
Supabase project (US East). Only read-only operations: TLS handshakes, `SELECT 1`, `LISTEN`,
`pg-boss version` and `prisma migrate status`. Decision: [ADR 0007](../../../adr/0007-tls-to-supabase.md).

Hosts, users, the project ref, passwords and IP addresses are replaced by `<...>` (`redact.cjs`). Both URLs came
from an uncommitted env file ending each in `?sslmode=verify-full`.

## Results

| Path                                                                          | Right CA                        | No `sslmode` | Unrelated CA                                   | Right CA, IP address as host   | File                 |
| ----------------------------------------------------------------------------- | ------------------------------- | ------------ | ---------------------------------------------- | ------------------------------ | -------------------- |
| `createPgPool`, `createPrismaClient`, `createBoss` pool and LISTEN, both URLs | TLSv1.3, verified               | refused      | `SELF_SIGNED_CERT_IN_CHAIN`                    | `ERR_TLS_CERT_ALTNAME_INVALID` | `runtime.txt`        |
| pg-boss CLI (`version`), session pooler                                       | TLSv1.3, verified, schema 48    | refused      | `SELF_SIGNED_CERT_IN_CHAIN`                    | `ERR_TLS_CERT_ALTNAME_INVALID` | `pgboss-cli.txt`     |
| Prisma CLI (`migrate status`), Debian 12, x86_64 and arm64                    | up to date, 3 of 3 each         | refused      | `P1011` certificate verify failed, 3 of 3 each | `P1011` IP address mismatch    | `prisma-linux-*.txt` |
| Prisma CLI, macOS                                                             | **`P1011` not trusted, 3 of 3** | not run      | `P1011`                                        | `P1011`                        | `prisma-macos.txt`   |

- `createPrismaClient` reports a TLS failure as Prisma's `P2010`; the `[tls]` line above it has Node's code.
- On macOS the two negative rows prove nothing, since the right CA fails too. `macos-trust.txt`: the system's TLS
  policy rejects the server's chain (`CSSMERR_TP_CERT_SUSPENDED`) although the chain itself verifies. The leaf is
  valid for 1,825 days and Apple's limit for TLS server certificates is
  [825](https://support.apple.com/en-us/103769); that this is the cause is an inference.
- The schema engine doesn't print its TLS state. That it verifies rests on the Linux rows: the connection requires
  TLS (`sslmode=require`), succeeds with the bundled CA and fails on an unrelated one.
- An earlier macOS and Linux attempt with Prisma's default 5 s connect timeout gave intermittent `P1001` instead of
  a TLS error (not kept). The saved Prisma runs add `connect_timeout=30`.

## The certificate

`ca-crosscheck.txt`. The root's SHA-256 fingerprint,
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, is the same in:

1. the chain both poolers send (`openssl s_client -starttls postgres -showcerts`, OpenSSL 3);
2. `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`, the file committed here
   (byte-identical to the PEM the server sends);
3. [`supabase/cli` at `6c34ee03`](https://github.com/supabase/cli/tree/6c34ee03a162274886df08a0f073df64c12eb491/apps/cli/src/command-internal/supabase-ca-templates),
   `prod-ca-2021.ts`;
4. a fingerprint quoted by a user in [supabase/supabase#50862](https://github.com/supabase/supabase/issues/50862),
   who says they downloaded it from the dashboard (seen as a search excerpt).

So it isn't trust on first use. It was not compared with a download from this project's dashboard.

## How to repeat

Run from the repo root. `$E` is this folder, `$WRONG` any CA certificate made for the test
(`openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Unrelated Test CA" -keyout k.pem -out wrong.crt`).

```sh
# runtime paths
( set -a; . ./.env.supabase; set +a
  NODE_OPTIONS="--require $E/tls-observer.cjs" \
    pnpm --silent --filter @repo/queue exec tsx src/spikes/tls-probe.ts --negative "$WRONG" 2>&1 | node $E/redact.cjs )

# pg-boss CLI; for the negative rows set DIRECT_URL="$(node $E/url-variant.cjs DIRECT_URL <variant> <ca>)"
( set -a; . ./.env.supabase; set +a
  NODE_OPTIONS="--require $E/tls-observer.cjs" pnpm --silent --filter @repo/queue pgboss version 2>&1 | node $E/redact.cjs )
```

`prisma-linux.sh` ran in `node:24-bookworm` with `DIRECT_URL` passed by `-e`, over a scratch folder mounted at `/w`:
`packages/db/` holding `prisma/`, `certs/`, `prisma.config.ts`, `src/{tls,tls-cli,supabase-ca}.ts`, a
`package.json` with `"type": "module"` and `npm install prisma@7.10.1`; `tools/` holding the script,
`url-variant.cjs`, `redact.cjs` and `wrong-ca.crt`.

Unit tests without a network: `packages/db/test/tls.test.ts`.

## Dropped connections (2026-11-28)

Some new connections from this Mac to the poolers die while being set up. Seen as
`Connection terminated unexpectedly` or `ECONNRESET`. Data: [`connect-drops/`](connect-drops/).

### Measurements

All fresh connections, `SELECT 1`, same Mac, times UTC. "Plain" is a scratch script outside the repo using raw `pg`
with TLS off (the repo refuses that). Both poolers asked for SCRAM, so no password crossed the network in clear.

| Run                                                                             | When        | TLS failed               | Plain failed |
| ------------------------------------------------------------------------------- | ----------- | ------------------------ | ------------ |
| `tls-probe.ts`, 6 runs of 8 (`probe-before.txt`)                                | 17:33-17:36 | 5 / 48                   | not run      |
| One at a time, TLS 1.3 and plain (`seq.jsonl`)                                  | 17:37-17:48 | 5 / 90                   | 0 / 90       |
| One at a time, TLS 1.3, TLS 1.2 and plain (`seq3.jsonl`)                        | 17:48-18:02 | 1.3: 3 / 90, 1.2: 2 / 90 | 0 / 90       |
| Bursts of 1, 4, 8 and 20 held open (`burst.jsonl`), without the 28 limit errors | 18:03-18:06 | 6 / 368                  | not run      |

- **Only TLS failed** in the two interleaved runs: 10 of 270 against 0 of 180 (Fisher's exact test, p = 0.007).
  TLS 1.2 fails too, so pinning a version is no fix.
- **Where:** all 10 died before the server asked for authentication. In 7 the client finished the handshake and saw
  the close within 10 ms, less than a round trip (about 385 ms), so the close wasn't a reply to anything sent after
  the handshake. In 3 the connection was cut during the handshake.
- **Parallel opens don't cause it:** the transaction pooler passed 198 of 198 in bursts; session-pooler bursts had 6
  drops in 170 attempts that stayed under the limit.
- **A different, explicit error is the session limit:** `(EMAXCONNSESSION) max clients reached in session mode - max
  clients are limited to pool_size: 15`, 28 times, only in bursts of 20 on `:5432`. Supabase documents
  [15 and 200 clients](https://supabase.com/docs/guides/platform/compute-and-disk) as the Nano defaults. The probe
  never holds more than two or so connections.
- **Supabase's logs** (checked by the coordinator, 17:25-17:33 UTC): `supavisor_logs` show only authenticated,
  terminated and backend-authenticated lines, with no errors, rejections, timeouts, limit or SSL messages. That
  window ends just before the runs above, and it fits drops that never reach authentication.

**Cause: not established.** It is before authentication and specific to TLS, so it isn't a pool limit or our query
path. One Mac on one network can't separate the network path from Supabase's TLS front end. The rate also moved over
the hour (see below). Supavisor has an open report about handshake bytes split across packets
([#1282](https://github.com/supabase/supavisor/issues/1282)), but it describes an explicit protocol error and plain
connections too, so it doesn't match.

### The fix: retry getting a connection

`createPgPool` (and `createPrismaClient` with a URL) now returns a pool that makes up to three attempts, 250 ms and
1 s apart, for `ECONNRESET`, `ETIMEDOUT`, `EPIPE` and node-postgres's two "Connection terminated" errors. Nothing has
been sent at that point. Statements, server errors (including `EMAXCONNSESSION`) and certificate errors are not
retried. `test/retry-pool.test.ts` drops connections in a local proxy and covers each of these.

Live, alternating a plain `pg.Pool` and `createPgPool` (`scripts/connect-reliability.ts`):

| Run                   | Parallel | Plain `pg.Pool` failed | `createPgPool` failed | Drops it retried |
| --------------------- | -------- | ---------------------- | --------------------- | ---------------- |
| `reliability-1.jsonl` | 4        | 1 / 250                | 0 / 250               | 1                |
| `reliability-2.jsonl` | 2        | 0 / 180                | 0 / 180               | 0                |

**This does not show a lower failure rate by itself:** drops had nearly stopped, and the difference isn't
significant. What it shows is the retry recovering real drops. The reduction rests on the local tests and on
arithmetic: at the earlier rate of about 4% per attempt, three independent failures would be under 1 in 10,000,
if drops are independent (not measured).

### Not covered, for Phase 4

1. **pg-boss's own connections** (`createBoss` with a URL: worker and sweeper). A failed poll or maintenance query
   is reported and repeated on the next cycle. `boss.start()` is not retried: wrap it.
2. **The worker's LISTEN connection.** If its first connect drops, pg-boss 12.40.0 emits a
   `listen_notify_unavailable` warning and polls only until restarted (read from `notifier.js`, not reproduced).
   The worker should watch for that warning and restart the boss.
3. **Session pool of 15.** The worker and sweeper both default to pools of 10 on `:5432`. Set `max` on every
   session-mode pool so their sum stays under 15, and keep Prisma in the worker on `DATABASE_URL` (`:6543`).
4. **CLIs** (pg-boss and Prisma migrate) have no retry. If `migrate.yml` fails with a dropped connection, re-run it.
5. If a drop ever hangs instead of closing, add a `connectionTimeoutMillis`; none was seen, so none was added. It
   would also limit waiting for a free connection in a full pool.

## Blocked on Zain

1. After every URL has `sslmode=verify-full` (GitHub secret, env files, Vercel): in the Supabase dashboard, _Database →
   Settings → SSL Configuration_, turn on **Enforce SSL on incoming connections**. Then re-run the `pgboss version`
   command above. At 17:37-18:02 UTC on 2026-11-28 plain connections still succeeded, so it was not on then.
2. Optional: in the same place, **Download certificate** and compare:
   `openssl x509 -in prod-ca-2021.crt -noout -fingerprint -sha256`.
