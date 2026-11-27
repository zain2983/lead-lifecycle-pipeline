# lead-lifecycle-pipeline

A synthetic ad click becomes a lead. An AI triage workflow, running on self-hosted [Sim](https://github.com/simstudioai/sim),
proposes a disposition with evidence for every field, and a person approves it before anything is written to the CRM
(HubSpot). Sales outcomes recorded in the CRM go back to the ad platforms (Meta Conversions API, Google Data Manager
API, Microsoft Advertising) as consent-aware, deduplicated conversions, and a daily reconciliation accounts for every
record at every hop.

**Status:** early build. Everything here is synthetic. Platform responses are shown exactly as they came back,
including errors and test-mode results.

## Layout

```
apps/web        Next.js: demo sites, API routes, operator console, case studies (port 3100)
apps/worker     local worker and operations CLIs
packages/*      core, db (Prisma 7), queue (pg-boss), crm-hubspot, agent-runtime (Sim v2 API client),
                synthetic, capture, identity, destinations/*, corrections, reconciliation
sim/            the triage workflow as code (Sim CLI source directory)
evals/          labelled cases, deterministic scorers, recordings, reports
infra/          local Postgres; self-hosted Sim
docs/           ADRs, evidence from real platforms, QA write-ups
```

## Run it locally

```sh
pnpm install
cp .env.example .env
pnpm db:up            # Postgres on localhost:5433
pnpm db:generate
pnpm check            # lint, type-check, tests
pnpm --filter @repo/web dev   # http://localhost:3100
```

Decisions are recorded in [`docs/adr/`](docs/adr/).
