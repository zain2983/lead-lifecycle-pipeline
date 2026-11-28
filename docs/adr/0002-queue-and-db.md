# 0002. Queue and database: pg-boss in the app's Postgres

- **Status:** accepted (Spike A done locally; the hosted re-runs are listed under "Not yet verified")
- **Date:** 2026-11-27
- **Versions:** pg-boss 12.40.0 (schema 48), Prisma 7.10.1 with `@prisma/adapter-pg`, pg 8.23.1,
  `@vercel/functions` 3.11.4, Next.js 16.4.6, PostgreSQL 17, PgBouncer 1.26.1
- **Evidence:** [`docs/evidence/spike-a/`](../evidence/spike-a/README.md)

## Context

The pipeline needs a durable queue with retries, dead-letter queues, idempotent enqueue and per-contact
ordering. It must cost $0, and it runs in three places: Vercel functions (short-lived, behind a transaction
pooler), a GitHub Actions sweeper every 10 minutes, and a local worker on a laptop that is often off.

## Decision

**pg-boss 12 in the same Postgres as the app, in the `pgboss` schema.** Enqueue happens in the same
transaction as the app's own writes, so an event is never recorded without its job, or the other way round.
`packages/queue` wraps it:

- `createBoss({ mode, connectionString | pool })` with three run modes (below).
- `prismaTxDb(tx)` runs a pg-boss call inside a Prisma interactive transaction. It wraps pg-boss's
  `fromPrisma` and refuses the root client, which would auto-commit the job on its own.
- `drainQueues()` (for `after()`) and `sweepOnce()` (for the sweeper) are built on pg-boss's own `drain()`
  and `supervise()`.
- `pnpm --filter @repo/queue migrate` is the only thing that creates or upgrades the pg-boss schema. It runs
  pg-boss's CLI, `pg-boss migrate`, with `DIRECT_URL` passed in `PGBOSS_DATABASE_URL`, so the URL never
  appears in argv. No runtime instance migrates (`migrate: false` everywhere). A schema older than the
  installed pg-boss makes `start()` throw instead of being upgraded from inside a request.

### Run modes

| Mode      | Where                              | pg-boss options                                                                                           | Pool                                                                                                                   |
| --------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `vercel`  | API routes and `after()`           | `migrate:false, supervise:false, schedule:false, max:2, registerInstance:false`                           | One instance per invocation, on a module-scoped `pg.Pool` (max 2) passed as `db` and wrapped with `attachDatabasePool` |
| `worker`  | local worker (Phase 4)             | `migrate:false, supervise:true, schedule:true`, registered as `worker`                                    | pg-boss's own pool                                                                                                     |
| `sweeper` | `pnpm ops sweep --once` on Actions | `migrate:false, supervise:true, schedule:false, registerInstance:false`; calls `supervise()` itself first | pg-boss's own pool, closed by `stop()`                                                                                 |

`registerInstance: false` follows pg-boss's docs for short-lived processes. The sweeper's own background
supervisor would first fire after 60 s, so the sweep calls `supervise()` explicitly, as pg-boss's `drain()`
docs advise for deployments that scale to zero.

### Connection matrix (Supabase Free)

Hosted URL shape: `postgresql://<user>:<password>@<pooler-host>:<6543 or 5432>/postgres?sslmode=verify-full`.

| Runtime           | Prisma                                                                                         | pg-boss                                             | Why                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Vercel function   | `DATABASE_URL` = transaction pooler `:6543`, through `new PrismaPg(pool)` on our own `pg.Pool` | same URL, `vercel` mode on our own pool             | Serverless needs the transaction pooler. Both pools are ours, so both can be wrapped with `attachDatabasePool`                     |
| Local worker      | `DATABASE_URL` (transaction pooler) is fine                                                    | **`DIRECT_URL` = session pooler `:5432`**           | LISTEN/NOTIFY needs a session-pinned connection. Through a transaction pooler it fails **silently** (below)                        |
| Sweeper (Actions) | `DIRECT_URL` (session pooler)                                                                  | `DIRECT_URL`, `sweeper` mode                        | It's a CLI, and the plan puts CLIs on the session pooler. It needs no LISTEN; through the transaction pooler it worked too (below) |
| `migrate.yml`, CI | `prisma migrate deploy` on `DIRECT_URL`                                                        | `pnpm --filter @repo/queue migrate` on `DIRECT_URL` | Migrations on the session pooler                                                                                                   |

- Every Supabase URL ends in `?sslmode=verify-full`, in every row of this matrix. The code refuses one without it
  and verifies the server against the bundled Supabase CA ([ADR 0007](0007-tls-to-supabase.md)). Local and CI URLs
  have no SSL parameter.
- Never use `db.<ref>.supabase.co`. It's IPv6-only, and Actions runners are IPv4.
- Prisma manages only `public`. pg-boss owns `pgboss`. Never run `prisma db pull`.
- Don't add `?pgbouncer=true`, and never set PrismaPg's `statementNameGenerator` on a transaction pooler
  (see the pooler results below).

### `attachDatabasePool`: what it does and where it applies

Read from the `@vercel/functions` 3.11.4 source, `db-connections/index.js`:

- It duck-types a pg pool (`pool.on` plus `idleTimeoutMillis` in `pool.options`; pg-pool always sets
  `idleTimeoutMillis`, default 10 s). It wraps `pool.connect` to remember which request checked each client
  out. On every `release` it calls that request's `waitUntil()` with a promise that resolves after
  `idleTimeoutMillis + 100 ms`, capped at the function's deadline minus 1 s. The instance stays alive until
  pg-pool has closed the idle clients, instead of being suspended while still holding them.
- It is only active when `VERCEL_URL` and `VERCEL_REGION` are set. Elsewhere it only wraps `connect`.
- **It needs a pool you can reach.** `new PrismaPg({ connectionString })` creates its pool lazily inside
  `connect()` and never exposes it. So `createPgPool()` makes the pool, the route attaches it, and
  `createPrismaClient(pool)` hands it to PrismaPg. PrismaPg checks `instanceof pg.Pool`, which only works
  when there is one copy of `pg`. There is: pg 8.23.1, shared by adapter-pg, pg-boss and `@repo/db`.
- **pg-boss's own pool is private** (created in `start()`, ended in `stop()`). Two options:
  - A pg-boss instance per invocation on its own pool needs no attach: `stop()` ends the pool, so nothing
    is left idle. But every invocation opens new connections.
  - The route uses a module-scoped pool passed as pg-boss's `db` (`createBoss({ mode: "vercel", pool })`,
    which wraps `pool.query`) and attaches it. A pg-boss instance per invocation on that pool costs no
    connections and leaves no timers after `stop()`. Measured locally: start 27–33 ms cold, 3–20 ms warm.
    The custom `db` has no `listen` or `beginTransaction`, which `vercel` mode doesn't use.

## Why not BullMQ on a hosted Redis free tier

The arithmetic is from `research/free-stack.md` §3.1. BullMQ 6.7.10's worker defaults are `drainDelay` 5 s,
`stalledInterval` 30 s and `lockDuration` 30 s. An idle worker blocks on a marker key, times out and asks
again:

- One idle worker, one queue: 86,400 s ÷ 5 s = **17,280 commands a day ≈ 518,400 per 30 days**. The free
  tier we priced allows **500,000 commands a month**, so it's over budget with zero traffic.
- The stalled-job check every 30 s adds 2,880 a day ≈ 86,400 a month per worker.
- Two workers (triage and conversions): **≈ 1.2 million commands a month at zero traffic**, plus about
  10–20 per job.
- Tuning helps (`drainDelay: 300`, `stalledInterval: 300000` ≈ 17,000 a month per worker). But it fights
  the defaults, slows stalled-job recovery to 5 minutes, and still needs an always-on host, and no free one
  exists without a card.

pg-boss adds no service, no bill and no new failure domain. The queue lives in the database the app already
has, and enqueue is transactional with the app's writes. What it costs: lower throughput than Redis
(irrelevant at demo scale), and someone must run its maintenance. Here that is the sweeper plus the worker.

**When I'd switch:** sustained throughput beyond what one Postgres should carry, or jobs that need
sub-second fan-out to many consumers. The first fallback is BullMQ's PostgreSQL backend (same API).

## Spike results (local, 2026-11-27)

| Claim                                                     | Result                                                                                                                                                                                      | Evidence                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Enqueue inside a Prisma interactive transaction           | Rollback leaves no job and no app row. Commit leaves exactly one. The job isn't visible outside the transaction until commit                                                                | `queue-tests.txt`, `test/prisma-tx.test.ts`                          |
| Deterministic job id dedupes                              | Second `send` with the same id returns `null`, one job. **The transaction's other writes still commit**, so app rows need their own unique key (the planned `webhook_events.dedupe_key`)    | same; `after-drain.txt` step 4 (heartbeat 29 written, no second job) |
| `after()` drain on `next start --port 3101`               | 202 returned; job `completed` by `after()` ~40 ms after enqueue; 5 concurrent POSTs each completed exactly once (drain counts 1+2+1+0+1 = 5); route is a 404 unless `SPIKE_ROUTES=1`        | `after-drain.txt`                                                    |
| A killed process's job is recovered by `ops sweep --once` | SIGKILLed holder (exit 137); job stays `active` past its 5 s expiry; the sweep's `supervise()` moved it to `retry`, the drain completed it (`retry_count` 1, `handledBy: sweeper`) in 47 ms | `kill-test.txt`, `test/sweep.test.ts`                                |
| `pg-boss migrate`                                         | Creates schema 48 on an empty database, no-op on the second run, `doctor` reports no drift. Also works through PgBouncer transaction mode                                                   | `migrate.txt`, `pooler-cli.txt`                                      |

### Through PgBouncer 1.26.1, transaction mode (`127.0.0.1:6433`)

| Check                                                                        | Direct     | `max_prepared_statements=0`                                  | `=200` (PgBouncer default)       |
| ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------ | -------------------------------- |
| pg, unnamed parameterised queries (PrismaPg's default)                       | ok         | ok                                                           | ok                               |
| pg, **named** prepared statements (what `statementNameGenerator` turns on)   | ok         | **`42P05 prepared statement "spike_stmt_0" already exists`** | ok                               |
| Prisma (adapter-pg) queries                                                  | ok         | ok                                                           | ok                               |
| pg-boss `vercel` mode: start, createQueue, send, fetch, complete             | ok         | ok                                                           | ok                               |
| Prisma transaction + `prismaTxDb` commit and rollback                        | ok         | ok                                                           | ok                               |
| pg-boss `supervise()` (advisory transaction locks, multi-statement SQL)      | ok         | ok                                                           | ok                               |
| **LISTEN/NOTIFY**: send-to-handler latency, notify queue, 30 s backstop poll | **0.01 s** | **28.5 s and 9.5 s, no warning**                             | **28.5 s and 9.5 s, no warning** |
| `?pgbouncer=true`                                                            | n/a        | no difference to any row                                     | no difference to any row         |

- **`?pgbouncer=true` doesn't matter with adapter-pg.** It's a flag for Prisma's old Rust query engine.
  node-postgres ignores the unknown URL parameter and doesn't send it as a startup parameter: PgBouncer,
  which rejects startup parameters it doesn't know, accepted every connection. PrismaPg already uses unnamed
  statements unless you set `statementNameGenerator`.
- **LISTEN through a transaction pooler degrades without a signal.** `LISTEN` succeeds, the server
  connection goes back to the pool, and notifications reach the listener only when one of its later queries
  happens to land on that server connection (its 10 s heartbeat), or not at all. pg-boss emitted no
  `listen_notify_unavailable` warning. Polling still delivers every job, so nothing is lost; only latency
  suffers. Hence the local worker's pg-boss goes on the session pooler.

## Consequences

- Every queue's `expireInSeconds` must be longer than its slowest handler: an expired job is retried while
  the first attempt may still run. It is also the recovery delay. A job a killed function held waits for
  expiry (default **15 minutes**) plus the next sweep (≤ 10 minutes). Queues drained by `after()` should
  use about 60–120 s. Long jobs (triage on Sim) use `heartbeatSeconds` instead.
- `createQueue` is idempotent (`ON CONFLICT DO NOTHING`) but never changes an existing queue's options.
  Phase 4 needs `updateQueue` for option changes; policy and partitioning can't be changed after creation.
- pg-boss rate-limits each maintenance step per queue across all instances (`monitorIntervalSeconds`,
  60 s). A sweep that runs within a minute of another instance's pass skips expiry for those queues. That's
  harmless at a 10-minute cadence, but tests use fresh queue names for it.
- The spike route, `spike-echo` and `spike-kill` are spike-only. Phase 4 replaces them.

## Decide in Phase 4: `key_strict_fifo` after a dead-lettered event

Verified on pg-boss 12.40.0 (`test/fifo-dead-letter.test.ts`). When a job on a `key_strict_fifo` queue
runs out of retries:

1. pg-boss copies it to the dead-letter queue (`sourceName` = the original queue);
2. the original stays `failed` and **keeps holding its key**: `getBlockedKeys()` lists the contact, and
   `fetch()` skips the contact's next job;
3. deleting (`deleteJob`) or retrying (`retry`) the failed original releases the key.

With `retryLimit 8`, exponential backoff and `retryDelayMax 3600`, a poison event holds its contact for
hours before it is even dead-lettered, because `retry` holds the key too.

Options:

- **Hold.** Do nothing. The contact's later events wait until an operator redrives or deletes the failed
  job. Order is never broken, which matters when a later stage change would be applied before an earlier
  one. The cost is one stuck contact per poison event, so it needs an alert on `getBlockedKeys()` and an
  `ops unblock`/`ops replay` runbook.
- **Release.** When a job is dead-lettered, delete the failed original (the dead-letter copy keeps the
  payload for replay), so the contact's next event runs. Nothing stalls, but a later event can overtake
  the dead-lettered one, and a replay then arrives out of order.
- **Per queue.** For example, hold on `conversion-*`, where order changes what the platforms receive, and
  release on `triage`, where each run re-reads the contact's current state.

My recommendation: per queue, as above. In every case, `pnpm ops queues` shows blocked keys and the
sweeper alerts when any key stays blocked longer than one sweep interval.

## Not yet verified

- Supabase's transaction pooler (Supavisor) instead of PgBouncer, and the IPv4 session pooler from Actions.
- `after()` and `attachDatabasePool` on real Vercel. Locally `attachDatabasePool` is a no-op.

Both need accounts, so they are listed with steps under "Blocked on Zain" in the evidence README.
