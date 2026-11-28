# lead-lifecycle-pipeline: rules for Claude Code

The build plan lives outside this repo (the author's private notes). Work one phase step at a time.

## Hard rules

1. **Synthetic data only.** No real people, no real PII, no client or employer data, ever. Emails use reserved
   domains: `example.com`, `example.org`, `example.net` and their subdomains (HubSpot rejects `*.test` emails as
   `INVALID_EMAIL`; `*.test` is fine for hostnames in free text). Phones use `+1 201-555-01xx` (555-0100 to
   555-0199 is reserved as fictional in every NANP area code, so these are valid 10-digit numbers that belong to
   no one).
2. **Tools, not targets.** HubSpot, Meta, Google and Sim appear only as tools this project
   uses. Never name a company as a target, customer or audience in code, docs, commits or the README.
3. **Never fake success.** Show test events, `validateOnly` results and the platforms' real errors exactly as they
   came back. A timeout is `unknown`, not `failed` and not `accepted`. No mocked response may be presented as live.
4. **No secrets in git.** Only `.env.example` files are committed. Evidence files in `docs/evidence/` have tokens,
   keys, emails and phone numbers redacted.
5. **$0.** Don't add a paid service, and don't add billing to any account.

## Stack and versions (pinned on purpose)

- Node ≥ 22.12 (CI uses 24), pnpm 11, Turborepo, TypeScript 6 (strict), Biome, Vitest, Playwright.
- Next.js 16 App Router in `apps/web` on port **3100** (Sim uses 3000 and 3002).
- **Prisma 7.10.1** with `@prisma/adapter-pg`. Use the v7 docs (`prisma.io/docs/orm/v7/...`); npm `latest` is
  a v8 RC. The URL lives in `packages/db/prisma.config.ts`. Never run `prisma db pull` (pg-boss owns `pgboss`).
- **pg-boss 12** in the same Postgres. Local Postgres: `pnpm db:up` → `localhost:5433`.
- Sim is self-hosted from `infra/sim` (pinned version); only the local worker calls it.

## Conventions

- Workspace packages are `@repo/*` and export TypeScript source (`./src/index.ts`). Relative imports use the `.ts`
  extension.
- Validate env with `loadEnv([...groups])` from `@repo/core`; add new variables to `packages/core/src/env.ts` and to
  `.env.example` (including its runtime matrix).
- Conventional commits (`feat(queue): …`, `fix(web): …`, `docs(adr): …`). Small PRs; never push to `main`.
- Decisions go in `docs/adr/NNNN-title.md`. Proof from real systems goes in `docs/evidence/` with a short README
  saying how it was produced.
- Before saying a change is done: `pnpm lint && pnpm typecheck && pnpm test` pass.
