# TLS to Supabase (ADR 0007)

Produced on 2026-11-28 from a Mac (macOS 26.5.1, arm64, Node 26.5) and Linux containers on it, against the hosted
Supabase project (US East). Only read-only operations: TLS handshakes, `SELECT 1`, `LISTEN`,
`pg-boss version` and `prisma migrate status`. Decision: [ADR 0007](../../../adr/0007-tls-to-supabase.md).

Hosts, users, the project ref, passwords and IP addresses are replaced by `<...>` (`redact.cjs`). Both URLs came
from an uncommitted env file ending each in `?sslmode=verify-full`.

## Results

| Path                                                                          | Right CA                        | No `sslmode` | Unrelated CA                                   | Right CA, IP address as host   | File                 |
| ----------------------------------------------------------------------------- | ------------------------------- | ------------ | ---------------------------------------------- | ------------------------------ | -------------------- |
| `createPgPool`, `createPrismaClient`, `createBoss` pool and LISTEN, both URLs | TLSv1.3, verified               | refused      | `SELF_SIGNED_CERT_IN_CHAIN`                    | `ERR_TLS_CERT_ALTNAME_INVALID` | `runtime.txt`        |
| pg-boss CLI (`version`), session pooler                                       | TLSv1.3, verified, schema 48    | refused      | `SELF_SIGNED_CERT_IN_CHAIN`                    | `ERR_TLS_CERT_ALTNAME_INVALID` | `pgboss-cli.txt`     |
| Prisma CLI (`migrate status`), Debian 12, x86_64 and arm64                    | up to date, 3 of 3 each         | refused      | `P1011` certificate verify failed, 3 of 3 each | `P1011` IP address mismatch    | `prisma-linux-*.txt` |
| Prisma CLI, macOS                                                             | **`P1011` not trusted, 3 of 3** | not run      | `P1011`                                        | `P1011`                        | `prisma-macos.txt`   |

- `createPrismaClient` reports a TLS failure as Prisma's `P2010`; the `[tls]` line above it has Node's code.
- On macOS the two negative rows prove nothing, since the right CA fails too. `macos-trust.txt`: the system's TLS
  policy rejects the server's chain (`CSSMERR_TP_CERT_SUSPENDED`) although the chain itself verifies. The leaf is
  valid for 1,825 days and Apple's limit for TLS server certificates is
  [825](https://support.apple.com/en-us/103769); that this is the cause is an inference.
- The schema engine doesn't print its TLS state. That it verifies rests on the Linux rows: the connection requires
  TLS (`sslmode=require`), succeeds with the bundled CA and fails on an unrelated one.
- An earlier macOS and Linux attempt with Prisma's default 5 s connect timeout gave intermittent `P1001` instead of
  a TLS error (not kept). The saved Prisma runs add `connect_timeout=30`.

## The certificate

`ca-crosscheck.txt`. The root's SHA-256 fingerprint,
`80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, is the same in:

1. the chain both poolers send (`openssl s_client -starttls postgres -showcerts`, OpenSSL 3);
2. `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`, the file committed here
   (byte-identical to the PEM the server sends);
3. [`supabase/cli` at `6c34ee03`](https://github.com/supabase/cli/tree/6c34ee03a162274886df08a0f073df64c12eb491/apps/cli/src/command-internal/supabase-ca-templates),
   `prod-ca-2021.ts`;
4. a fingerprint quoted by a user in [supabase/supabase#50862](https://github.com/supabase/supabase/issues/50862),
   who says they downloaded it from the dashboard (seen as a search excerpt).

So it isn't trust on first use. It was not compared with a download from this project's dashboard.

## How to repeat

Run from the repo root. `$E` is this folder, `$WRONG` any CA certificate made for the test
(`openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Unrelated Test CA" -keyout k.pem -out wrong.crt`).

```sh
# runtime paths
( set -a; . ./.env.supabase; set +a
  NODE_OPTIONS="--require $E/tls-observer.cjs" \
    pnpm --silent --filter @repo/queue exec tsx src/spikes/tls-probe.ts --negative "$WRONG" 2>&1 | node $E/redact.cjs )

# pg-boss CLI; for the negative rows set DIRECT_URL="$(node $E/url-variant.cjs DIRECT_URL <variant> <ca>)"
( set -a; . ./.env.supabase; set +a
  NODE_OPTIONS="--require $E/tls-observer.cjs" pnpm --silent --filter @repo/queue pgboss version 2>&1 | node $E/redact.cjs )
```

`prisma-linux.sh` ran in `node:24-bookworm` with `DIRECT_URL` passed by `-e`, over a scratch folder mounted at `/w`:
`packages/db/` holding `prisma/`, `certs/`, `prisma.config.ts`, `src/{tls,tls-cli,supabase-ca}.ts`, a
`package.json` with `"type": "module"` and `npm install prisma@7.10.1`; `tools/` holding the script,
`url-variant.cjs`, `redact.cjs` and `wrong-ca.crt`.

Unit tests without a network: `packages/db/test/tls.test.ts`.

## Blocked on Zain

1. After every URL has `sslmode=verify-full` (GitHub secret, env files, Vercel): in the Supabase dashboard, _Database →
   Settings → SSL Configuration_, turn on **Enforce SSL on incoming connections**. Then re-run the `pgboss version`
   command above.
2. Optional: in the same place, **Download certificate** and compare:
   `openssl x509 -in prod-ca-2021.crt -noout -fingerprint -sha256`.
