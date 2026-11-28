# 0007. TLS to Supabase: encrypted and verified, or refused

- **Status:** accepted (checked live on 2026-11-28 with read-only commands; the GitHub runner and Vercel aren't
  checked yet)
- **Date:** 2026-11-28
- **Numbering:** 0004 and 0005 are reserved for the Phase 8 ADRs.
- **Versions:** pg 8.23.1, pg-connection-string 2.14.1, pg-boss 12.40.0, Prisma 7.10.1
- **Evidence:** [`docs/evidence/phase-1/supabase-tls/`](../evidence/phase-1/supabase-tls/README.md)

## Context

Supabase's poolers accept plaintext, and node-postgres sends plaintext unless told otherwise. So a URL as the
dashboard gives it connected with no TLS. `sslmode=require` fails (`SELF_SIGNED_CERT_IN_CHAIN`), because the
server's chain ends in Supabase's own root CA, which no system store holds.

Two different TLS stacks read these URLs. node-postgres (the app, pg-boss and its CLI) and the Prisma CLI's schema
engine (`migrate deploy`), which has its own URL parameters.

## Decision

1. **The URL carries the rule.** A Supabase URL (`*.supabase.com`, `*.supabase.co`) must say
   `sslmode=verify-full`. Anything else, including no SSL parameter, is refused with `TlsConfigError` before a
   connection is opened. Other URLs, such as local Docker and CI, are passed through unchanged.
2. **The root CA is in the repo** (`packages/db/certs/supabase-root.crt`, with an embedded copy for the app
   runtime). It is not added to any system store.
3. **One module translates the rule** (`packages/db/src/tls.ts` and `tls-cli.ts`):

   | Path                                                                        | What it receives                                                                       |
   | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
   | `createPgPool`, `createPrismaClient`, `createBoss` (pool and LISTEN client) | the URL with every SSL parameter removed, plus `ssl: { ca, rejectUnauthorized: true }` |
   | pg-boss CLI (`runPgBossCli`)                                                | the URL plus `sslrootcert=<bundled file>`                                              |
   | Prisma CLI (`prisma.config.ts`)                                             | `sslmode=require&sslaccept=strict&sslcert=<bundled file>`                              |
   - The parameters are removed because node-postgres lets a URL's `ssl*` parameters replace an explicit `ssl`
     object.
   - The schema engine needs `sslaccept=strict`. Prisma's
     [v6 docs](https://www.prisma.io/docs/orm/v6/overview/databases/postgresql) give its default as
     `accept_invalid_certs` and describe `sslcert` as the CA path. The
     [v7 page](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql) shows only `sslmode`
     and `sslcert`, so the behaviour was checked live instead.
   - A URL with its own `sslrootcert` keeps that CA (the negative tests use this).

**New code that opens a Postgres connection must go through these functions.** A bare `new pg.Pool({
connectionString })` on a Supabase URL ending in `sslmode=verify-full` fails (unknown CA); on one without it, it
connects in plaintext.

## Alternatives not taken

- **`uselibpqcompat=true&sslmode=require`:** encrypts but doesn't verify the server.
- **`NODE_EXTRA_CA_CERTS`:** an extra variable in every runtime, does nothing for the Prisma engine, and a URL
  without `sslmode` would still be plaintext.
- **Applying the CA by host name alone, with no URL parameter:** the Prisma CLI would still need translating, and
  the connection string would no longer say how it is protected.

## Consequences

- **Rollout order.** The URLs (GitHub secret, local env files, later Vercel) need the parameter when this code
  arrives. Without it `migrate.yml` fails at `pnpm db:generate`, because `prisma.config.ts` applies the rule on
  every Prisma command that has a `DIRECT_URL`.
- **Prisma CLI on macOS can't reach Supabase.** The schema engine uses the system's TLS library there, and macOS
  distrusts the server certificate (`P1011 The certificate was not trusted`). The likely reason is its 1,825-day
  lifetime against Apple's 825-day limit. Node paths are unaffected. Linux works, so run hosted Prisma commands in
  `migrate.yml` or a Linux container. We don't loosen verification for macOS.
- **CA expiry and rotation.** The root expires on 2031-04-26. Supabase's CLI also bundles a second root, with the
  same name, valid from 2025 to 2035; the poolers didn't send it. If they move to it, every connection fails until
  the file is replaced.
- Prisma's 5 s default connect timeout was sometimes too short from a laptop far from the database (`P1001`). It
  is left at the default.

## Not yet verified

- `migrate.yml` on GitHub's Ubuntu runner (checked in Debian 12 containers).
- The app on Vercel (the runtime paths were run from a Mac; `next build` succeeds).
- Behaviour with Supabase's "Enforce SSL" setting on.
