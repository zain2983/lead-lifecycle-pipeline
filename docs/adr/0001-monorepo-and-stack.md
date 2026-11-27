# 0001. Monorepo and stack

- **Status:** accepted
- **Date:** 2026-11-27

## Context

The project has a public Next.js app (demo sites, API routes, an operator console), a long-running local worker,
CLIs, a Sim workflow written as code, and several small libraries (capture, identity, destinations, corrections,
reconciliation). They share types, env validation and the database. Everything has to run for $0.

## Decision

- **One pnpm workspace with Turborepo.** Apps in `apps/`, libraries in `packages/` (`@repo/*`). Libraries export
  TypeScript source; Next.js compiles them with `transpilePackages`, and the worker runs them with `tsx`. No build
  step per package, so there is nothing to keep in sync.
- **TypeScript 6, strict**, with `noUncheckedIndexedAccess`. Not TypeScript 7 yet: 7 is the native (Go) compiler, and
  the Next.js type-check and editor plugin still depend on the JavaScript compiler API. Revisit when Next.js supports it.
- **Node ≥ 22.12, CI on Node 24** (`.nvmrc`). Prisma 7.10 supports 20.19+, 22.12+ and 24+, and warns on newer
  majors, so run Node 24 locally too.
- **Biome** for lint and format (one tool, fast, no plugin tree). Rules that matter here: no `any`, no non-null
  assertions, type-only imports.
- **Vitest** for unit and contract tests; **Playwright** for end-to-end tests in a separate workflow.
- **Prisma 7.10.1, pinned**, with `@prisma/adapter-pg`. The driver adapter lets the same client run in Vercel
  functions (transaction pooler) and in the worker (session pooler). npm `latest` is a v8 release candidate, so the
  version is pinned and the v7 docs are the reference.
- **pg-boss 12** as the queue, in the same Postgres (see ADR 0002).
- **pnpm 11 build-script allow-list** (`allowBuilds` in `pnpm-workspace.yaml`): only Prisma's engines and esbuild may
  run install scripts.

## How this differs from Sim's own stack

Sim, which runs the triage agent here (ADR 0003), is built with Bun, Drizzle and Trigger.dev. This repo uses pnpm,
Prisma and pg-boss instead:

- **Runtime:** this repo is a _client_ of Sim. It talks to Sim only through its v2 HTTP API and its CLI, so it
  doesn't need Sim's toolchain. pnpm and Node are what Vercel and GitHub Actions run with no extra setup.
- **ORM:** Prisma's migrations and driver adapters cover the two connection modes this project needs (above).
- **Background jobs:** Trigger.dev Cloud's free tier and a self-hosted Trigger.dev both add a service to run and
  watch. pg-boss is a library on the Postgres that already exists, so the queue adds no cost and no new failure
  domain. The trade-off is that workers must be run by us: `after()` on Vercel, a GitHub Actions sweeper and the
  local worker (ADR 0002).

The upstream contribution to Sim (a separate repository) follows Sim's own toolchain and rules.

## Consequences

- One `pnpm install` sets up everything; `pnpm check` runs lint, type-check and tests across the workspace.
- CI runs `prisma generate` before the type-check, because the generated client is not committed.
- Adding a package means a `package.json` that exports `./src/index.ts`, a `tsconfig.json` that extends the base,
  and an entry in `transpilePackages` if the web app imports it.
