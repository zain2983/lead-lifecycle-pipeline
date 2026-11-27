# Spike B: self-hosted Sim (PLAN Phase 1, step 5)

Run on 2026-11-27/28 on the author's Mac (Docker Desktop, 12 GB, 10 CPUs) against Sim **v0.9.66** (tag = commit
`1814ccd`) with the `sim` CLI **2.3.0**. Everything ran on the local instance with the synthetic user
`builder@example.com`. Nothing here came from Sim Cloud or any other external account.

Redaction: API keys, passwords, cookies and email addresses are replaced with `[redacted]` / `[redacted-email]`. The
CLI's one-time pairing values are redacted too. Workspace, workflow, block and run IDs are left in: they belong to
this local instance only and are needed to follow the exchanges.

## How it was produced

```sh
# 1. start Sim (images pinned to v0.9.66; secrets in the gitignored infra/sim/.env)
docker compose -f infra/sim/docker-compose.yml up -d --wait
docker stats --no-stream
# 2. synthetic user, workspace and personal API key on the local instance
infra/sim/bootstrap.sh
# 3. CLI login into a repo-local, gitignored config dir
export SIM_CONFIG_DIR=$PWD/infra/sim/.cli DO_NOT_TRACK=1 SIM_NO_UPDATE_CHECK=1
pnpm exec sim login --profile local --endpoint http://localhost:3000 --method api-key --no-browser
export SIM_PROFILE=local
# 4. workflow as code (each command's output is in cli/)
pnpm exec sim workflows source create --dir sim/hello --workspace <ws>     # starter + types
pnpm exec sim workflows source check  --dir sim/hello
pnpm exec sim workflows source create --dir sim/hello --dry-run
pnpm exec sim workflows source create --dir sim/hello --yes
pnpm exec sim workflows source apply  --dir sim/hello --dry-run
pnpm exec sim workflows source apply  --dir sim/hello --yes --deploy       # version 1
#    edit the Echo function to return 'v2', then check, apply --dry-run, apply --yes --deploy   # version 2
#    same create/check/deploy flow for sim/hello-approval                                          # version 1
# 5. live API checks (root .env: SIM_BASE_URL, SIM_API_KEY, SIM_WORKSPACE_ID)
pnpm --filter @repo/agent-runtime spike            # idempotency, versions, hitl
pnpm --filter @repo/agent-runtime spike reject     # approved:false
```

`live/*.json` are written by `packages/agent-runtime/scripts/spike-b.ts`. Each holds the script's `notes` and the
raw `exchanges`: method, URL, request headers and body, response status, selected headers and body, exactly as sent
and received.

## Files

| File                                             | What                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `startup.txt`                                    | `up -d --wait` result (healthy in 22 s), container list, ports, image digests |
| `docker-stats-idle.txt`, `docker-stats-load.txt` | Memory idle, and after a burst of 30 concurrent async runs                    |
| `image-pull-stall.txt`                           | Docker Desktop log of the first image pull, which hung for 27 min             |
| `bootstrap.txt`                                  | `infra/sim/bootstrap.sh` (sign-up, workspace, personal key)                   |
| `cli-login.txt`                                  | `sim login --profile local` through API-key pairing, then `sim whoami`        |
| `hubspot-providers.txt`                          | The HubSpot credential providers this instance offers                         |
| `cli/01`–`09`                                    | Every `sim workflows source` command for both workflows, v1 and v2            |
| `cli/10-recreate-from-source.txt`                | Recreating a workflow from `workflow.ts` alone and with a stale `lock.json`   |
| `live/01-idempotency.json`                       | Async execute with `X-Run-Id`, then the same ID again                         |
| `live/02-versions.json`                          | Versions list; active v2 vs `run.version: 1`; unknown version                 |
| `live/03`–`07`                                   | Human block: pause, list paused, resume, resume again, cancel another         |
| `live/08-hitl-reject.json`                       | Resume with `approved: false`                                                 |

## Verified

- **Self-host.** All images exist at `v0.9.66` for arm64. The stack is healthy 22 s after `up` once images are
  present. Ports are 3000 and 3002 on `127.0.0.1`; nothing is published on 3100 or 5433. Migrations exit 0. With
  `CRON_SECRET` set, the cron jobs (`/api/resume/poll`, the outbox and others) answer successfully.
- **Memory.** Idle: app 1.21 GiB (8 GiB limit), realtime 80 MiB, Postgres 90 MiB, Redis 10 MiB, cron 20 MiB, about
  1.4 GiB in total. After 30 concurrent trivial runs: app 1.55 GiB. No LLM work was measured.
- **Local account.** Sign-up over Sim's auth API needs no email verification (it is off by default on a self-hosted
  install), and `example.com` passes the disposable-email gate. Creating a workspace also creates a `default-agent`
  workflow.
- **CLI login.** `sim login --profile local --endpoint http://localhost:3000` works through API-key pairing. The
  approval step is a signed-in `POST /api/cli/auth/approve`. `whoami` reports a personal, full-access key that never
  expires.
- **Workflow as code.**
  - `create` on an empty directory only writes a starter and types (`created: false`).
  - `check` → `create --dry-run` → `create --yes` creates the workflow and writes `.sim/`.
  - `apply --yes --deploy` deploys even when the apply is a no-op (version 1).
  - Changing the function and applying again gives `modified: echo (code)` and version 2.
  - `status` afterwards reports no local or server changes.
- **Instance-specific files.** `.sim/lock.json` holds instance IDs (each block's UUID, the Start input fields' IDs).
  `.sim/base.json` holds the workflow ID, workspace ID, fingerprint and catalog hash. `create` from a copy carrying
  a stale lock succeeds and assigns new block IDs (`cli/10`), so neither file is needed to recreate a workflow.
  Both are gitignored.
- **Idempotent execute.** First async execute → `202` with our run ID. The same `X-Run-Id` again →
  `409 {"error":{"code":"CONFLICT","message":"Run ID has already been used","details":{"code":"RUN_ID_CONFLICT"}}}`.
  The run completed once.
- **`run.version`.** With v2 active, the active run returned `"version":"v2"` and the run pinned to `version: 1`
  returned `"version":"v1"`, with run status `version: 1`. An unknown version gave `404 NOT_FOUND "Version not found"`.
- **Human in the loop.**
  - An async run of `hello-approval` reports `status: "paused"` with one human pause point. Its `contextId` equals the
    Human block's ID, and it lists the form's `inputFields` and the display data.
  - `GET /api/v2/workflows/runs/paused?workspaceId=…` lists it.
  - Resume with `{contextId, input:{approved:true}}` → `202` and a **new, server-assigned run ID**. The resumed run
    completed with `decision: "approved"`, and the original run then reports `completed`.
  - A second resume of the same pause point → `409 {"error":{"code":"CONFLICT","message":"Paused execution is not
    resumable"}}`, with no `details.code`. The run had finished, so the "Pause point already resumed or in progress"
    branch was not the one hit.
  - Cancel of a second paused run → `200`, `success: true`, `pausedCancelled: true`, `reason: "recorded"`. It then
    reports `cancelled` and is gone from the paused list.
  - `approved: false` takes the Condition's else branch (`decision: "rejected"`): resuming does not approve anything.
- **HubSpot credential without OAuth.** With no HubSpot OAuth client in Sim's env, `sim credentials providers list`
  shows `hubspot` (OAuth) as `available: false` and `hubspot-service-account` ("HubSpot service key") as
  `available: true`.
- **Telemetry off.** `NEXT_TELEMETRY_DISABLED=1` is set for the server and `DO_NOT_TRACK=1` for every CLI call.

## Assumed (not verified here)

- A resume of a run that is _still resuming_ answers `409 "Pause point already resumed or in progress"` (code at the
  tag, `human-in-the-loop-manager.ts`). Only the finished-run case was observed.
- Memory under LLM load. Only trivial Function runs were measured.
- `sim/hello` recreated on a brand-new instance. A second instance was not run; `cli/10` recreated from source on the
  same instance under a new name.
- `WORKFLOW_TESTS=true` enables workflow tests (it is read as a fallback in `lib/core/config/feature-flags.ts`, but
  the live docs page doesn't list it, and no test file was run in this spike).

## Blocked on Zain

**HubSpot service key in Sim (PLAN step 5, bullet 6).** There is no HubSpot account yet. When the `demo` developer
test account exists:

1. In HubSpot (`demo` test account): **Development → Keys → Service keys** (in some accounts **Settings →
   Integrations → Service keys**) → **Create service key**. Name it `sim-local`, then **Add new scope**:
   `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read` → **Create** → open the key →
   **Show** → **Copy**.
2. Start Sim (`docker compose -f infra/sim/docker-compose.yml up -d --wait`), open <http://localhost:3000> and sign in
   as `builder@example.com` (password: `SIM_LOCAL_USER_PASSWORD` in `infra/sim/.env`).
3. Workspace sidebar → **Integrations** → search **HubSpot** → **Add to Sim** → **Add service key** → paste the key into
   **Service key or private app token** → display name `HubSpot demo` → **Add service key**. Sim checks the key against
   HubSpot's token-info endpoint and shows a specific error if it fails.
4. Tell the next session the credential exists; `pnpm exec sim credentials list` will then show it.

No OAuth client (`HUBSPOT_CLIENT_ID`/`SECRET`) is needed in Sim's env for this (verified above).
