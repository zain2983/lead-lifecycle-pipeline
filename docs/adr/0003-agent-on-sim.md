# 0003. The triage agent runs on Sim

- **Status:** accepted
- **Date:** 2026-11-27
- **Evidence:** [`docs/evidence/spike-b/`](../evidence/spike-b/README.md) (Phase 1, Spike B)

## Context

The triage step reads a new lead, proposes a disposition with evidence for every field, waits for a person to
approve it, and only then writes to the CRM. It needs four things that are expensive to build well:

1. a workflow definition that lives in git and can be reviewed as a diff;
2. a durable pause for a human decision that survives restarts, with an API to list, resume and cancel it;
3. a way to run an **earlier** deployed version next to the current one, so an eval gate can compare them;
4. per-run logs (trace spans, inputs, outputs, cost) that a reviewer can read after the fact.

[Sim](https://github.com/simstudioai/sim) (Apache-2.0 core) is a workflow and agent platform that provides all four.
It is self-hosted here from Docker images at a pinned version (`infra/sim/`). Nothing from `apps/sim/ee/` is used.

## Decision

Run the triage workflow on self-hosted Sim, **v0.9.66**, driven from this repo by the `sim` CLI **2.3.0** (a pinned
root devDependency) and by `@repo/agent-runtime`, a small typed client for Sim's v2 HTTP API.

- **Workflow as code.** Each workflow is a CLI source directory under `sim/<name>/` (`workflow.ts`, optional
  `functions/`, `.sim/lock.json`). `sim workflows source check` compiles it offline with Sim's own compiler;
  `apply --dry-run` runs every server check; `apply --yes --deploy` saves and deploys. The file is declarations
  only (the server compiles it statically and never runs it), so a review sees exactly what will execute.
- **Human in the loop.** A Human block named `Approval` pauses the run with no timeout. The worker finds paused runs
  with `GET /api/v2/workflows/runs/paused`, resumes one with `POST …/runs/{runId}/resume` and
  `{contextId, input: {approved, comment}}`, and cancels leftovers with `POST …/runs/{runId}/cancel`. A Condition
  after the Human block checks `approved === true`: resuming does not itself approve anything.
- **`run.version` for evals.** `POST …/execute` with `run: {source: "deployment", version: N}` runs deployed version
  N even after N+1 is active, so the eval harness can score both on the same cases. Versions being compared are
  never undeployed.
- **Idempotent starts.** Every execute sends `X-Run-Id`. Reusing a claimed ID returns `409` (`RUN_ID_CONFLICT`)
  and starts nothing, so a queue retry can never start a second run (verified). A resume gets a new,
  server-assigned run ID; a second resume of the same pause point is refused with `409` (observed message:
  "Paused execution is not resumable", with no detail code, so the worker treats any `409` on resume as "already
  decided"). `@repo/agent-runtime` turns timeouts and dropped connections into
  `SimOutcomeUnknownError` (outcome `unknown`), never into a failure or a success.
- **Logs API.** `GET /api/v2/logs/{runId}` returns the trace spans, final output and cost of a run. Eval reports
  store the redacted JSON per case, so a reviewer doesn't need access to the instance.

### Only the local worker calls Sim

Sim runs on the developer's Mac (ports 3000 and 3002, published on `127.0.0.1` only). Vercel functions and GitHub
Actions runners can't reach it, and exposing it through a tunnel would put an admin surface and an API key on the
internet. So:

- the **local worker** is the only process with `SIM_API_KEY` and the only consumer of the triage queue;
- approvals made in the web console are written to Postgres; the local worker polls them and calls resume;
- when the worker is off, triage jobs and approvals wait in the queue. Nothing fails, nothing is skipped.

The env matrix in `.env.example` gives `SIM_*` to the local worker only.

## Consequences and risks

- **Preview features.** Workflows as code (`WORKFLOW_CODE=true`) and workflow tests (`WORKFLOW_TESTS=true`) are
  preview flags in Sim. Their syntax or CLI flow can change between releases. Mitigation: both the server and the
  CLI are pinned, `sim workflows source check` runs before every apply, and the eval harness talks to the stable v2
  API, not to preview endpoints.
- **CLI and server versions are pinned together.** `SIM_VERSION=v0.9.66` in `infra/sim/.env` and `sim@2.3.0` in
  `package.json` move together, in one PR, after re-running the spike checks. No `latest` tags: every image in
  `infra/sim/docker-compose.yml` refuses to start without `SIM_VERSION`.
- **Instance-specific state.** `.sim/base.json` names a workspace and workflow on one instance. A fresh instance
  (or a reviewer's) recreates the workflow from the committed source with `sim workflows source create`; see
  `sim/README.md`. Run IDs, version numbers and log JSON are evidence of one instance, not portable configuration.
- **12 GB of RAM.** Sim's own sizing for an evaluation install is 2 cores and 12 GiB, and the compose file caps the
  app container at 8 GiB. Docker Desktop on this Mac has 12 GB. Measured in Spike B: about 1.4 GiB idle (app
  1.21 GiB) and 1.55 GiB for the app after 30 concurrent trivial runs (`docker-stats-*.txt`); LLM-heavy runs are not
  measured yet. Playwright and Sim are not run at the same time, and Sim is stopped with `docker compose down`
  (volumes kept) when it isn't needed.
- **First start downloads about 1.2 GB.** On this connection the first pull of the app image hung for 27 minutes on
  containerd layer locks (`image-pull-stall.txt`); killing and re-running the pull fixed it.
- **Telemetry.** The self-hosted server sends anonymous traces to Sim's collector unless `NEXT_TELEMETRY_DISABLED=1`,
  and the CLI reports usage unless `DO_NOT_TRACK=1`. Both are off here (`infra/sim/.env.example`, `sim/README.md`).
- **A second toolchain to watch.** Sim's release cadence is fast. An upgrade is a deliberate PR: bump both pins,
  re-run the spike script and the workflow checks, and re-record evals if a deployed workflow changed.

## Alternatives considered

- **A hand-written agent loop in the worker (for example LangGraph.js).** It would need its own pause store, resume
  API, version pinning and log viewer, which is most of the work above, built and maintained here.
- **Sim Cloud.** Same API, but the free tier is 1,000 one-time credits and 2 concurrent runs, too few for repeated
  eval runs, and it needs an account. It stays an option for a public demo, never for the gate.
