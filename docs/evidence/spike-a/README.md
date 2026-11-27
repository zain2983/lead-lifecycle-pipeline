# Spike A: the queue (PLAN Phase 1, steps 3 and 4)

Produced on 2026-11-27 on a Mac (Node 26.5, pnpm 11.21) against the local Postgres 17 container
(`pnpm db:up`, database `spike_queue` on `localhost:5433`). pg-boss 12.40.0, Prisma 7.10.1 with
adapter-pg, Next.js 16.4.6, PgBouncer 1.26.1. Decisions and analysis: [ADR 0002](../../adr/0002-queue-and-db.md).

No file here contains a secret. The only credentials involved are the local container's `app`/`app`,
which are already in `infra/docker-compose.yml`; connection strings are printed as `<pooler :6433>` or not at all.

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

## Assumed (not measured here)

- **`attachDatabasePool` behaviour on Vercel.** It is read from the `@vercel/functions` 3.11.4 source;
  locally it's a no-op because `VERCEL_URL`/`VERCEL_REGION` are unset.
- **`after()` on Vercel** runs through `waitUntil` within the route's `maxDuration` (60 s here).
  Measured only on `next start`.
- **Supavisor** (Supabase's transaction pooler on `:6543`) behaves like PgBouncer in transaction mode
  for these checks. Its prepared-statement support may differ: run the checks there before relying on it.
- The timings are from a laptop with the database on the same machine. Hosted round trips add tens of
  milliseconds per query.

## Blocked on Zain

1. **Re-run the pooler checks against Supabase.** This needs a Supabase account and a Free project
   (no card).
   1. In the project, open _Connect_ and copy the **Session pooler** URI (`…pooler.supabase.com:5432`)
      and the **Transaction pooler** URI (same host, `:6543`).
   2. In a local, uncommitted `.env`, set `DATABASE_URL` and `DIRECT_URL` to the session-pooler URI.
   3. Run `pnpm db:deploy && pnpm --filter @repo/queue migrate`.
   4. Run `pnpm --filter @repo/queue exec tsx src/spikes/pooler.ts --pooler-port 6543 >
      docs/evidence/spike-a/supabase-pooler.jsonl`. Target `direct` is then the session pooler, and
      `pooler`/`pooler-pgbouncer` are the transaction pooler.
   5. Check that the file has no host or user name before committing it; the script never prints URLs.
2. **Verify `after()` and `attachDatabasePool` on Vercel.** This needs a Vercel login and a Hobby project
   for `apps/web`.
   1. On one deployment, set `DATABASE_URL` to the Supabase transaction-pooler URI and `SPIKE_ROUTES=1`.
   2. `curl -X POST https://<deployment>/api/spikes/queue -d '{"key":"vercel-1"}'`, wait 2 s, then
      `curl "https://<deployment>/api/spikes/queue?id=<jobId>"`. Expect `completed` and
      `handledBy: "after()"`.
   3. Save the function log lines containing `"spike":"queue"`.
   4. Remove `SPIKE_ROUTES` and redeploy.
   5. Preview deployments are protected: use the production URL of a throwaway project, or a protection
      bypass token. Never commit that token.
