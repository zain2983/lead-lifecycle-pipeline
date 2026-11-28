# Spike A: the queue (PLAN Phase 1, steps 3 and 4)

Produced on 2026-11-27 on a Mac (Node 26.5, pnpm 11.21) against the local Postgres 17 container
(`pnpm db:up`, database `spike_queue` on `localhost:5433`). pg-boss 12.40.0, Prisma 7.10.1 with
adapter-pg, Next.js 16.4.6, PgBouncer 1.26.1. Decisions and analysis: [ADR 0002](../../adr/0002-queue-and-db.md).

No file here contains a secret. The only credentials involved are the local container's `app`/`app`,
which are already in `infra/docker-compose.yml`; connection strings are printed as `<pooler :6433>` or not at all.
The Supabase files from 2026-11-28 hold no host, user, password or connection string.

## What was run

| #   | Command                                                                                                                                                                                                                          | Output                                                                                                                                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm db:deploy` then `pnpm --filter @repo/queue migrate` (pg-boss CLI). Transcript re-run on throwaway schemas: `… pgboss version / migrate / migrate / doctor --schema pgboss_evidence`, and a fresh install through PgBouncer | [`migrate.txt`](migrate.txt)                                                                                                                         |
| 2   | `cd packages/queue && pnpm exec vitest run --reporter=verbose` (transactional enqueue, expire→retry→complete, triage refusal, drain, key_strict_fifo after a dead-letter)                                                        | [`queue-tests.txt`](queue-tests.txt)                                                                                                                 |
| 3   | `bash apps/web/scripts/spike-queue-proof.sh`: `next build`, then `next start --port 3101` without and with `SPIKE_ROUTES=1`, and curl                                                                                            | [`after-drain.txt`](after-drain.txt)                                                                                                                 |
| 4   | `bash apps/worker/scripts/kill-test.sh`: SIGKILL a process holding an active job, then `pnpm ops sweep --once`                                                                                                                   | [`kill-test.txt`](kill-test.txt)                                                                                                                     |
| 5   | `docker compose -f infra/docker-compose.yml --profile core --profile pooler up -d --no-deps --wait pgbouncer`, then `pnpm --filter @repo/queue exec tsx src/spikes/pooler.ts`                                                    | [`pooler-max-prepared-0.jsonl`](pooler-max-prepared-0.jsonl), config: [`pooler-max-prepared-0.config.txt`](pooler-max-prepared-0.config.txt)         |
| 6   | Same with PgBouncer's default prepared-statement support: `PGBOUNCER_MAX_PREPARED_STATEMENTS= docker compose … up -d --no-deps --force-recreate --wait pgbouncer`, then `… pooler.ts --targets pooler,pooler-pgbouncer`          | [`pooler-max-prepared-200.jsonl`](pooler-max-prepared-200.jsonl), config: [`pooler-max-prepared-200.config.txt`](pooler-max-prepared-200.config.txt) |
| 7   | `DIRECT_URL=<pooler :6433> pnpm --filter @repo/queue pgboss version` and `… migrate`                                                                                                                                             | [`pooler-cli.txt`](pooler-cli.txt)                                                                                                                   |

The config files are `SHOW CONFIG` lines from PgBouncer's admin console (`name|value|default|changeable`),
read with `docker exec llp-postgres-1 psql "postgresql://app:app@pgbouncer:5432/pgbouncer" -Atc "show config"`.

In `kill-test.txt` the sweep lists `triage` as skipped. An earlier test run had left a `triage` queue
behind in `spike_queue`. The test now removes any `triage` queue it creates, and that queue was deleted.

## Verified

- **Transactional enqueue** (`prismaTxDb(tx)`):
  - A rollback leaves no job and no app row.
  - A commit leaves exactly one job, invisible outside the transaction until commit.
  - The same deterministic job id sent twice leaves one job; the second `send` returns `null`.
  - Passing the root Prisma client throws.
- **The deterministic id doesn't dedupe the transaction's other writes.** On the duplicate POST the route
  still wrote heartbeat 29 (`after-drain.txt`, step 4).
- **`after()` drain** under `next start --port 3101`:
  - The route answers 404 to POST and GET when `SPIKE_ROUTES` is unset.
  - With `SPIKE_ROUTES=1`, POST returns 202, and the job is `completed` by `after()` 42 ms after it was
    created (`handledBy: "after()"`).
  - Five concurrent POSTs: all five completed, each processed exactly once (drain counts 1+2+1+0+1).
- **Kill test:**
  - The holder is killed with SIGKILL (exit 137). Its job is still `active` 7.6 s after it started,
    2.6 s past its 5 s expiry, because no supervisor runs.
  - `pnpm ops sweep --once` (supervise, then drain, 47 ms) takes it from `active` through `retry` to
    `completed`, with `retry_count` 1 and `handledBy: "sweeper"`.
  - The sweep writes Heartbeat 16 (source `sweeper`).
- **pg-boss migrate:** the CLI creates schema 48 on an empty schema and is a no-op on a second run.
  `doctor` finds no drift. A fresh install also works through PgBouncer in transaction mode.
- **PgBouncer transaction mode:**
  - Unnamed statements (PrismaPg's default), Prisma queries, pg-boss send/fetch/complete/supervise, and
    Prisma-transaction enqueue with commit and rollback all work.
  - Named prepared statements fail with `42P05 prepared statement "spike_stmt_0" already exists` at
    `max_prepared_statements=0`, and work at 200.
  - `?pgbouncer=true` makes no difference anywhere.
  - LISTEN/NOTIFY pickup takes 28.5 s and 9.5 s through the pooler, against 0.01 s direct, and pg-boss
    emits no warning.
- **`key_strict_fifo` after a dead-letter:**
  - The failed original keeps its key, `getBlockedKeys()` lists it, and the contact's next job isn't
    fetched.
  - `deleteJob` releases it. The dead-letter copy carries `sourceName`.

## Live on Supabase (2026-11-28)

Produced from the same Mac against the hosted Supabase Free project (US East, already migrated by `migrate.yml`,
so no migration was run here). `DATABASE_URL` was the transaction pooler `:6543` and `DIRECT_URL` the session pooler
`:5432`, loaded from an uncommitted env file inside a subshell. In the output, `direct` is the **session pooler** and
`pooler` / `pooler-pgbouncer` are the **transaction pooler**.

```sh
# 1. Full spike, script as of c6646f3 -> supabase-pooler.jsonl
( set -a; . ./.env.supabase; set +a; export DATABASE_URL="$DIRECT_URL";
  pnpm --filter @repo/queue exec tsx src/spikes/pooler.ts --pooler-port 6543 ) \
  > docs/evidence/spike-a/supabase-pooler.jsonl

# 2. LISTEN/NOTIFY only, run three times and appended -> supabase-listen.jsonl
( set -a; . ./.env.supabase; set +a; export DATABASE_URL="$DIRECT_URL";
  pnpm --silent --filter @repo/queue exec tsx src/spikes/pooler.ts --pooler-port 6543 \
    --targets direct,pooler --listen-only --listen-settle-ms 10000 ) \
  >> docs/evidence/spike-a/supabase-listen.jsonl
```

The first attempt at command 1 ran no check: the worktree had no generated Prisma client (`ERR_MODULE_NOT_FOUND`).
After `pnpm db:generate` it exited 0 with an empty stderr. So did all three runs of command 2.

**Don't use the LISTEN/NOTIFY rows in `supabase-pooler.jsonl`.** They show pickup in 0.77 s and 0.80 s through the
transaction pooler (1.80 s on the session pooler). The script waited only 1.5 s for the worker's first poll before
sending. With a round trip near 0.4 s, the likely explanation is that the first poll was still starting and fetched
the job itself. `--listen-settle-ms` (default still 1500) and a raw `LISTEN`/`pg_notify` probe without polling were
added to the script, and command 2 repeats the check with them.

### Results

| Check                                         | Local direct / PgBouncer (`=0`)       | Supabase session `:5432`              | Supabase transaction `:6543` (plain and `?pgbouncer=true`) |
| --------------------------------------------- | ------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| 40 unnamed queries (`pg`)                     | ok 34 ms / ok 33 ms                   | ok 6507 ms                            | ok 6372 / 8065 ms                                          |
| 40 **named** prepared statements              | ok 5 ms / `42P05`                     | ok 4495 ms                            | **`42P05`** 385 / 372 ms                                   |
| 40 Prisma queries                             | ok 88 ms / ok 24 ms                   | ok 5628 ms                            | ok 7050 / 6032 ms                                          |
| pg-boss `vercel` mode round trip              | ok 41 ms / ok 28 ms                   | ok 6080 ms                            | ok 5769 / 7857 ms                                          |
| Prisma tx + `prismaTxDb`, commit and rollback | ok 48 ms / ok 31 ms                   | ok 9225 ms                            | ok 9417 / 12629 ms                                         |
| `supervise()` alone                           | ok 24 ms / ok 19 ms                   | ok 2229 ms                            | ok 6334 / 4112 ms                                          |
| Raw `NOTIFY` to an idle listener, 3 runs      | not run                               | **delivered 3/3**: 1.94, 1.91, 1.93 s | **delivered 0/3** (gave up about 10 s after the send)      |
| pg-boss pickup, 10 s settle, 3 runs           | not run (1.5 s settle: 0.01 / 28.5 s) | 2.85, 4.73, 3.90 s                    | 4.99, 20.38, 24.30 s; no warnings                          |

Times are for the whole check (including opening connections), one sample each, except the last two rows. The
transaction-pooler column of the last two rows has no `?pgbouncer=true` runs.

Latency from this Mac (10 × `SELECT 1` on a warm connection, one run, not saved as a file): typically 391–410 ms on
both poolers, with outliers of 1.07–1.73 s. Opening a connection took 1.6 s.

### TLS: these connections were not encrypted

Neither URL sets an SSL parameter, node-postgres then uses no TLS, and both poolers accepted that. All the runs above
were made that way (synthetic data only). [`supabase-tls.jsonl`](supabase-tls.jsonl) is a `SELECT 1` on each URL
under three settings:

| URL parameters                        | Result on both poolers                                               |
| ------------------------------------- | -------------------------------------------------------------------- |
| none                                  | connects, **no TLS**                                                 |
| `sslmode=require`                     | fails, `SELF_SIGNED_CERT_IN_CHAIN` (pg 8 treats it as `verify-full`) |
| `uselibpqcompat=true&sslmode=require` | connects with TLS, certificate **not verified**                      |

Verifying the certificate against Supabase's CA was not tested. No code or setting was changed.

Fixed afterwards: see [ADR 0007](../../adr/0007-tls-to-supabase.md) and
[`../phase-1/supabase-tls/`](../phase-1/supabase-tls/README.md). The commands above now need
`?sslmode=verify-full` on both URLs.

### Cleanup

A read-only transaction on the session pooler, after both commands:

```text
queues like spike-pooler-% / spike-listen-% : none
all rows in pgboss.queue                    : __pgboss__send-it
jobs in those queues                        : 0
heartbeat rows with source like pooler:%    : 0
tables named like %spike%                   : none
```

Nothing had to be deleted.

### Verified

- Supavisor's transaction pooler gives the same pass/fail verdicts as PgBouncer with `max_prepared_statements=0`:
  unnamed statements, Prisma, pg-boss send/fetch/complete/supervise and transactional enqueue work; named prepared
  statements fail with `42P05`; `?pgbouncer=true` changes no verdict.
- An idle `LISTEN` through `:6543` received nothing (0/3), while `:5432` received every notification. pg-boss raised
  no warning. ADR 0002's rule (the local worker's pg-boss uses the session pooler) holds on Supabase.

### Assumed or not measured

- Why one transaction-pooler pg-boss run picked the job up in 4.99 s. The 20 s and 24 s runs fit the 30 s poll.
- Timings from inside Vercel or GitHub Actions. The numbers here are dominated by this Mac's distance to US East.
- Behaviour under load, or with more clients than the pooler's pool size.

## Assumed (not measured here)

These are from the local run; the Supavisor and latency points are answered above.

- **`attachDatabasePool` behaviour on Vercel.** It is read from the `@vercel/functions` 3.11.4 source;
  locally it's a no-op because `VERCEL_URL`/`VERCEL_REGION` are unset.
- **`after()` on Vercel** runs through `waitUntil` within the route's `maxDuration` (60 s here).
  Measured only on `next start`.
- **Supavisor** (Supabase's transaction pooler on `:6543`) behaves like PgBouncer in transaction mode
  for these checks. Its prepared-statement support may differ: run the checks there before relying on it.
- The timings are from a laptop with the database on the same machine. Hosted round trips add tens of
  milliseconds per query.

## Blocked on Zain

1. ~~**Re-run the pooler checks against Supabase.**~~ **Done 2026-11-28**, see "Live on Supabase".
2. **Verify `after()` and `attachDatabasePool` on Vercel.** The project and production URL exist
   (`https://lead-lifecycle-pipeline.vercel.app`). The function needs the database password, which only Zain adds.
   1. In the Vercel project, under _Settings → Environment Variables_, add for **Production** only:
      - `DATABASE_URL`: the Supabase **transaction pooler** URI (`:6543`) ending in `?sslmode=verify-full`
        ([ADR 0007](../../adr/0007-tls-to-supabase.md)), marked Sensitive.
      - `SPIKE_ROUTES`: `1`.
   2. Redeploy production, so the deployment picks the variables up. While `SPIKE_ROUTES=1`, anyone who knows the URL
      can enqueue spike jobs, so do steps 3 to 5 in one sitting.
   3. `curl -i -X POST https://lead-lifecycle-pipeline.vercel.app/api/spikes/queue -d '{"key":"vercel-1"}'`.
      Expect `202` and a `jobId`.
   4. Wait a few seconds, then
      `curl "https://lead-lifecycle-pipeline.vercel.app/api/spikes/queue?id=<jobId>"`. Expect `"state":"completed"`
      and `handledBy` `after()` in `output`.
   5. From the project's runtime logs, save the lines containing `"spike":"queue"` (`enqueued`, `after-drain`).
   6. Remove `SPIKE_ROUTES`, redeploy, and check that the POST now answers `404`. `DATABASE_URL` can stay.
   7. The check leaves the `spike-echo` queues in `pgboss` and heartbeat rows with source `web:spike-queue`.
