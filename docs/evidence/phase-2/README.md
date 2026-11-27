# Phase 2: domain model and synthetic data, lite (PLAN Phase 2)

- **Date:** 2026-11-28. **Branch:** `phase/2`. **Machine:** macOS, Node 26.5.0 locally (CI uses 24), pnpm 11.21.0,
  Postgres 17 in `llp-postgres-1`, database `phase2`.
- **Scope:** the schema, `@repo/synthetic`, and `pnpm hs:setup` / `pnpm hs:seed`. No HubSpot account exists yet, so
  **no request in this folder went to HubSpot.** Every HubSpot response here came from the in-process fake
  (`startFakeHubSpot` in `@repo/crm-hubspot/testing`). Its responses carry `x-fake-hubspot: 1`, and the CLIs print
  `NOT HubSpot` whenever `HUBSPOT_API_BASE_URL` points anywhere but `https://api.hubapi.com`. The keys used are
  synthetic strings. Outputs show fixture keys and fake record IDs, never emails.
- **Result:** offline part done. The live runs in both accounts are **Blocked on Zain** (steps below).

## Files

| File                                | What it is                                                                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma-migrate.txt`                | `pnpm db:migrate` applying `20261127214257_domain_model` to `phase2`; a second run that finds no drift; `migrate status`; the tables, enums and the 17 CHECK constraints as Postgres reports them                                                              |
| `synthetic-seed-42.txt`             | `generate --seed 42 --summary` (every key, scenario and intended label), then the output's sha256 three times, the third under `TZ=Pacific/Chatham LANG=tr_TR.UTF-8`, and the eval phones' format (numbers redacted)                                           |
| `offline-run.ts`, `offline-run.txt` | the real root commands `pnpm hs:setup` / `pnpm hs:seed` for both accounts against two fakes, twice each; then drift, two 429s, a hung upsert and a missing key. After each step: exit code, the fake's request and write counts, and a hash of its whole state |
| `unit-tests.txt`                    | verbose Vitest output for `db` (14), `synthetic` (23), `crm-hubspot` (69) and `core` (12)                                                                                                                                                                      |

## How it was produced

```sh
docker exec llp-postgres-1 createdb -U app phase2        # .env points DATABASE_URL and DIRECT_URL at it
pnpm install && pnpm db:generate
pnpm db:migrate --create-only --name domain_model         # then the CHECK constraints were appended by hand
pnpm db:migrate
pnpm --filter @repo/db erd                                # writes the README "Data model" diagram
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter @repo/synthetic generate --seed 42 --summary
pnpm --filter @repo/crm-hubspot exec tsx ../../docs/evidence/phase-2/offline-run.ts > docs/evidence/phase-2/offline-run.txt
```

## Verified (offline)

1. **One migration, no drift.** `domain_model` adds 8 tables and 6 enums. A second `migrate dev` reports "Already in
   sync", so the hand-written CHECK constraints don't look like drift to Prisma. Each constraint is tested
   against the migrated database (`packages/db/test/constraints.test.ts`), in rolled-back transactions:
   - reserved-domain lead emails only (`example.com/org/net`, `*.test`), lower-case;
   - a retried webhook event inserts once (`ON CONFLICT (dedupe_key) DO NOTHING`);
   - `agent_run.status` accepts `unknown` and rejects anything outside the set;
   - one approval per run, and a decision always comes with an approver and a time;
   - a shadow run never gets a resume run ID;
   - IDs and `updated_at` default in the database, so raw SQL inserts work.
2. **The ERD is generated, and a test fails when it's stale** (`packages/db/test/erd.test.ts`).
3. **Same seed, same bytes.** Three runs of seed 42 (`SYNTHETIC_VERSION` 2) give the sha256 `759acaa6…ca79ac7`,
   including one in a fresh process under another time zone and locale. A test pins that hash.
4. **Reserved domains and phone format.** The tests scan every email, URL, `domain` field and hostname in message
   text, over five seeds, and fail on anything outside `example.com/org/net` and `*.test`. They also check that the
   checker itself rejects lookalikes (`example.co`, `notexample.com`, `*.invalid`). Every phone is
   `+1 201-555-01xx`: a valid 10-digit NANP number in the block reserved as fictional in every area code (a test
   checks the digits are `1-NXX-NXX-XXXX`). Only a duplicate shares its original's phone.
5. **Labels.** The eval set covers all 7 disposition cases and all 5 triage labels. Every B2B label matches the
   score rule. Keys never reveal the scenario.
6. **Clock traps.** The eval set holds:
   - a Karachi date that differs from the UTC date, and a New York date that differs from the UTC date;
   - a submission at exactly Karachi midnight;
   - clicks at `2026-11-01T01:30:00-04:00` and `…-05:00`.

   The demo leads fall on both sides of the US DST change.
7. **`hs:setup` twice and `hs:seed` twice give identical end states, and the second run reports no changes**
   (`offline-run.txt`, `setup-and-seed.test.ts`):
   - setup: run 1 is `created 15` (17 requests). Run 2 is `unchanged 15` (2 requests, 0 writes), and the state hash
     is unchanged;
   - seed: run 1 is `created 20` (demo) or `created 10` (eval), with 1 read and 1 upsert. Run 2 is `unchanged`, with
     1 read, **0 upserts** and the same state hash.
8. **Drift and re-seeds.** A label renamed "in the UI" gets one PATCH carrying only `label`. One edited contact gets
   one upsert, and its row says `updated (firstname)`. A `triage_disposition` written later survives a re-seed,
   because the seed never writes `triage_disposition`, `triage_confidence`, `lifecyclestage` or `hs_lead_status`.
9. **Honest outcomes.**
   - Two 429s on the batch read were retried after 293 ms and 827 ms (capped exponential backoff with jitter).
   - A hung upsert gave `unknown 20` and exit 2, with nothing reported as created or failed. A re-run settled
     it.
   - A missing key exits 1 before any request is sent.
   - The unit tests also cover these cases: DAILY 429s aren't retried; a write's 5xx is `unknown`; a read's 5xx and
     timeout are retried; the limiter waits when its own window or HubSpot's headers say so; the key never appears
     in an error.

## Assumed (check on the first live run)

1. **The 2026-09 paths work with a service key.** HubSpot's "latest" reference pages show `/crm/properties/2026-09/…`
   and `/crm/objects/2026-09/…`, GA since 2026-09-08, and list `/crm/v3` as legacy. Not yet called for real.
2. **Updating a group** uses `PATCH /crm/properties/2026-09/contacts/groups/{name}`. That is the v3 shape; I found no
   2026-09 page for it. It runs only if someone renamed our group's label.
3. **HubSpot stores the seed's values verbatim**, so a second live seed reads back equal strings. If it normalises
   one of them, every re-run will say `updated (<that field>)`. The fix is then to compare normalised values. The
   likely candidates:
   - `phone` (`+1 201-555-01xx` is a valid NANP number, but HubSpot may reformat it, e.g. to `+1201555xxxx`);
   - the bool `consent_gpc`;
   - the message text.
4. **Bool options round-trip.** `consent_gpc` is created with options `Yes/true` and `No/false`. If HubSpot rewrites
   bool options, a second `hs:setup` will say `updated (options)` for it.
5. **Rate-limit tier.** The docs don't say which tier a developer test account counts as. The client assumes the
   lowest (100 per 10 s) and uses 50. One full run is at most 17 requests.
6. **What the docs don't say, and the code doesn't depend on:**
   - what creating an existing name returns (the code reads again after any failed create);
   - how a batch read reports missing emails (200 or 207; a missing contact is one with no result);
   - what "partial upserts are not supported when using email as the idProperty" means (a failed batch marks every
     contact in it `failed`, with HubSpot's body). The fake makes its own choice for each of these, documented in
     `fake-hubspot.ts`.
7. **The default contact properties exist in a developer test account:** `email`, `firstname`, `lastname`, `phone`,
   `company`, `jobtitle`, `city`, `country` and `message`.

## Blocked on Zain

Needs the two developer test accounts (`demo`, `eval`) from Phase 0. Per account:

1. In HubSpot: **Development → Keys → Service keys → Create service key**, with the scopes
   `crm.schemas.contacts.read`, `crm.schemas.contacts.write`, `crm.objects.contacts.read` and
   `crm.objects.contacts.write`. Put it in the repo-root `.env` as `HUBSPOT_SERVICE_KEY_DEMO`
   (or `HUBSPOT_SERVICE_KEY_EVAL`). Leave `HUBSPOT_API_BASE_URL` unset.
2. Run these, and save each output to `docs/evidence/phase-2/live/<account>-<step>.txt`. The output has no emails or
   keys; check before committing anyway.

   ```sh
   pnpm hs:setup --account demo --dry-run      # expect 15 "would be created"
   pnpm hs:setup --account demo                # expect created 15, exit 0
   pnpm hs:setup --account demo                # expect unchanged 15
   pnpm hs:seed --account demo --seed 42 --dry-run
   pnpm hs:seed --account demo --seed 42       # expect created 20
   pnpm hs:seed --account demo --seed 42       # expect unchanged 20, "upserts 0"
   ```

   For `eval`, the same commands with `--account eval`. Expect 10 contacts.
3. Check the account itself: **Settings → Properties → Contact properties** should show the group "Lead lifecycle
   pipeline" with 14 properties, and **Contacts** should show 20 (demo) or 10 (eval).
4. If a second run says `updated (…)`, or a call fails, keep the output exactly as it is. That is assumption 3, 4 or
   1 failing, and the fix goes in the comparison, not in the evidence.
5. After `hs:setup` in `demo`, the Phase 3.4 webhook subscription to `triage_disposition` can be enabled.
6. Re-run both commands after every 90-day test-account renewal (PLAN Phase 2.4).
