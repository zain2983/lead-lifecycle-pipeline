# Sim workflows (as code)

Each folder here is a `sim` CLI source directory: one Sim workflow written as TypeScript. Sim compiles the file
statically on the server; nothing in it runs on your machine. Why the agent runs on Sim, and why only the local
worker calls it: [ADR 0003](../docs/adr/0003-agent-on-sim.md).

| Folder            | What it is                                                                           |
| ----------------- | ------------------------------------------------------------------------------------ |
| `hello/`          | Spike B. Start (API) → Function (echo + timestamp) → Response. No LLM                |
| `hello-approval/` | Spike B. Start (API) → Human `Approval` → Condition on `approved` → Response. No LLM |
| `hubspot-smoke/`  | Start (API) → HubSpot Get Contacts → Function → Response. Reads one contact. No LLM  |

Pinned versions: Sim server **v0.9.66** (`infra/sim/.env`), `sim` CLI **2.3.0** (root `package.json`). Change them
together, in one PR.

## 1. Self-host Sim

Needs Docker Desktop with 12 GB of memory. Sim uses ports 3000 and 3002 (bound to `127.0.0.1`); it never touches
3100 (web app) or 5433 (app Postgres). Don't run Playwright while Sim is up.

```sh
cp infra/sim/.env.example infra/sim/.env
# fill the empty secrets: the one-liner at the top of .env.example prints all of them
docker compose -f infra/sim/docker-compose.yml up -d --wait    # first start pulls ~1.2 GB of images
```

Stop it when you're done, keeping the data (`postgres_data` volume):

```sh
docker compose -f infra/sim/docker-compose.yml down
```

Start it again later with the same `up -d --wait`. `down -v` deletes the volume, so the account, workspace, API key
and workflows are gone; recreate them with steps 2 and 4.

## 2. Local account, workspace and API key

The instance is local and the account is synthetic (`builder@example.com`, a random password in `infra/sim/.env`).
Email verification is off by default on a self-hosted install, so no inbox is needed.

```sh
infra/sim/bootstrap.sh
```

It signs the user up (or in), creates a workspace, creates a **personal** API key (saving workflow source acts as a
person, so a workspace key is refused), and writes `SIM_LOCAL_WORKSPACE_ID` and `SIM_LOCAL_API_KEY` into
`infra/sim/.env`. It never prints the key. The same steps in the UI: sign up at <http://localhost:3000>, then
Settings → Sim API keys → Create.

Copy the two values into the root `.env` as `SIM_WORKSPACE_ID` and `SIM_API_KEY` for the worker and the spike
script.

## 3. Log in with the CLI

Keep the CLI's config, credentials and catalog cache inside the repo (gitignored), and turn off its usage reporting
and update check. Every command below assumes these:

```sh
export SIM_CONFIG_DIR="$PWD/infra/sim/.cli" DO_NOT_TRACK=1 SIM_NO_UPDATE_CHECK=1
```

Either use the key directly, with no stored login:

```sh
export SIM_ENDPOINT=http://localhost:3000 SIM_API_KEY=<SIM_LOCAL_API_KEY> SIM_WORKSPACE=<SIM_LOCAL_WORKSPACE_ID>
pnpm exec sim whoami
```

or store a login in a `local` profile. `sim login` always needs an approval: it prints a pairing code and a
`http://localhost:3000/cli/auth?...` URL. Open it in a browser signed in as the local user and approve. (Spike B
approved it without a browser by posting the URL's `request` and `challenge` to `/api/cli/auth/approve` with the
local user's session; see `docs/evidence/spike-b/cli-login.txt`.)

```sh
pnpm exec sim login --profile local --endpoint http://localhost:3000 --method api-key --no-browser
export SIM_PROFILE=local
pnpm exec sim whoami          # "authenticated": true, keyType "personal", workspace "Local dev"
```

## 4. Create, check, apply, deploy

A new workflow is created from a directory with `create`. Until `create --yes` runs there is no `.sim/base.json`,
so `apply` refuses the directory. After that, every change goes through `apply`.

```sh
# 1. empty directory: writes a starter workflow.ts, the workspace's types and .sim/AGENTS.md; creates nothing
pnpm exec sim workflows source create --dir sim/hello --workspace "$SIM_WORKSPACE"
# 2. write workflow.ts, then compile it offline with Sim's compiler
pnpm exec sim workflows source check --dir sim/hello
# 3. create the workflow on the server (dry run first)
pnpm exec sim workflows source create --dir sim/hello --dry-run
pnpm exec sim workflows source create --dir sim/hello --yes
# 4. every later change: check, dry run, save and deploy (each --deploy is a new version)
pnpm exec sim workflows source check --dir sim/hello
pnpm exec sim workflows source apply --dir sim/hello --dry-run
pnpm exec sim workflows source apply --dir sim/hello --yes --deploy
```

`create` and `apply` rewrite `workflow.ts` in canonical form (single quotes, comments moved); read it again before
the next edit. Biome skips these folders (`biome.json`) so it never fights the CLI's formatting. Never undeploy a
version an eval still compares. The outputs of each step in Spike B are in `docs/evidence/spike-b/cli/`.

## 5. Recreate on a fresh instance

A clone has no `.sim/` folders (they are gitignored, see below). On a fresh instance (a new machine, a reviewer's,
or after `down -v`):

1. steps 1–3 above;
2. for each folder, create the workflow from the committed source and deploy it. `hubspot-smoke/` first needs a
   HubSpot service-key credential named `HubSpot demo` (commands in `docs/evidence/spike-b`, "Live"):

   ```sh
   pnpm exec sim workflows source create --dir sim/hello --workspace "$SIM_WORKSPACE" --yes --deploy
   pnpm exec sim workflows source create --dir sim/hello-approval --workspace "$SIM_WORKSPACE" --yes --deploy
   ```

   This writes a new `.sim/` (new block IDs, new `base.json`) and deploys version 1. A stale `.sim/lock.json` from
   another instance does no harm: `create` ignores its IDs and writes new ones (verified,
   `docs/evidence/spike-b/cli/10-recreate-from-source.txt`).
3. Version numbers are per instance. To get an older version back as a deployed version, check out its commit,
   `apply --yes --deploy`, then return to the current source and deploy again. In Spike B, `hello` v1 is the source in the commit
   `feat(sim): hello and hello-approval workflows as code` and v2 is the commit after it.

## What is committed

| File                                            | Committed | Why                                                                                       |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `workflow.ts`, `functions/*`                    | yes       | The source                                                                                |
| `tsconfig.json`, `.gitattributes`               | yes       | Relative paths only; type-checks against `.sim/sdk` once `create` or `get` has written it |
| `.sim/lock.json`                                | no        | Instance IDs: each block's stored UUID, and the IDs of the Start block's input fields     |
| `.sim/base.json`                                | no        | Instance IDs: workflow, workspace, fingerprint, catalog hash                              |
| `.sim/stored-edges.json`, `.sim/written.json`   | no        | The CLI's bookkeeping for `status` and `diff` on this machine                             |
| `.sim/sdk/`, `.sim/examples/`, `.sim/AGENTS.md` | no        | Regenerated by `create` or `get` from the instance's block catalog and workspace          |
| `tsconfig.full.json`                            | no        | Holds an absolute path into this machine's CLI cache                                      |

Eval recordings (Phase 6) are keyed on a hash of `workflow.ts` and `functions/`, never on `.sim/`, so they don't
change between instances.
