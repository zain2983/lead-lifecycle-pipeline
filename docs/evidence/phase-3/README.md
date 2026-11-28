# Phase 3: HubSpot integration (PLAN Phase 3)

- **Date:** 2026-11-28. **Branch:** `phase/3`. **Machine:** macOS, Node 26.5.0 locally (CI uses 24), pnpm 11.21.0,
  Postgres 17 in `llp-postgres-1`, database `phase3`.
- **Scope:** OAuth refresh, the OAuth-or-service-key client with an allow-listed contact read, the webhook intake (one
  transaction per batch), the `hubspot_direct` Lead upsert in the worker's `triage` job, the privacy purge, the draft
  conversion mapping, and the `prod` app.
- **No HubSpot account exists yet, so no request in this folder went to HubSpot.** HubSpot's side is always a local
  stand-in: `hs:replay` signing with a synthetic client secret, an in-process fake token endpoint and an in-process fake
  CRM API (`@repo/crm-hubspot/testing`; every fake response carries `x-fake-hubspot: 1`). Contract fixtures are
  `source: docs`, built from HubSpot's documented examples with synthetic values.
- **Result:** offline part done. The live install, refresh and webhooks are **Blocked on Zain** (below).

## Files

| File                                                 | What it is                                                                                                                                                                                                                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-webhook-replay.txt`, `.sh`                       | `pnpm hs:replay` against `next start --port 3100` (production build) and Postgres: retries as attempts 0, 1, 2; batches with retries inside; the three signature cases; then the `crm_event` rows and the `triage` job as stored |
| `02-offline-worker-run.txt`, `offline-worker-run.ts` | the real `triage` handler drains that job: OAuth refresh with the stored, encrypted install, contact read, `hubspot_direct` Lead (fake token endpoint and fake CRM API)                                                          |
| `03-privacy-deletion.txt`, `.sh`                     | `contact.privacyDeletion` for that contact, and its retry, through the server; the Lead before and after                                                                                                                         |
| `server-logs.txt`                                    | the server's own log lines for 01 and 03 (one routing line per stored event; LAN IP redacted)                                                                                                                                    |
| `batch-retry-inside.json`, `privacy-deletion.json`   | the two extra replay inputs (synthetic, like `packages/crm-hubspot/fixtures`)                                                                                                                                                    |
| `prisma-migrate.txt`                                 | `migrate status`, a second `migrate dev` with no drift, and the new constraints and columns as Postgres reports them                                                                                                             |
| `next-build.txt`                                     | `next build` with no HubSpot variables                                                                                                                                                                                           |
| `unit-tests.txt`                                     | verbose Vitest output: crm-hubspot 98, web 34, worker 5, queue 10, core 16, db 16                                                                                                                                                |

## How it was produced

```sh
pnpm install && pnpm db:generate
pnpm db:migrate --create-only --name token_refresh_and_purge_check   # then the CHECKs were appended by hand
pnpm db:migrate && pnpm --filter @repo/db erd
pnpm lint && pnpm typecheck && pnpm test
cd apps/web && pnpm exec next build && cd ../..
# The .env has no client secret; a synthetic one is exported for the server and hs:replay alike.
(cd apps/web && HUBSPOT_CLIENT_SECRET=synthetic-offline-secret-phase3 pnpm exec next start --port 3100) &
docs/evidence/phase-3/01-webhook-replay.sh > docs/evidence/phase-3/01-webhook-replay.txt
pnpm --filter @repo/worker exec tsx ../../docs/evidence/phase-3/offline-worker-run.ts > docs/evidence/phase-3/02-offline-worker-run.txt
docs/evidence/phase-3/03-privacy-deletion.sh > docs/evidence/phase-3/03-privacy-deletion.txt
```

## Verified (offline)

1. **Done when: retries give one row and one job.** Through the production build (`01`), one contact creation sent as
   attempts 0, 1 and 2 answered `stored 1, enqueued 1`, then `duplicates 1` twice; the database holds one `crm_event`
   (attempt 0) and one `triage` job whose ID is `uuidv5("job:triage:" + dedupe key)`. A batch with retries inside it
   (`batch-retry-inside.json`: the creation again, lifecycle attempts 0 and 1) stored only the 2 new events; the mixed
   fixture batch, then all of it again as attempt 1, stored 2 and then 0. Five distinct events end as five rows. The
   same cases run as tests on every `pnpm test` (`apps/web/test/hubspot-intake.test.ts`), plus five concurrent
   deliveries of one batch (stored once).
2. **One transaction per batch, and a failure answers 500.** A pg-boss send that fails mid-batch rolls back the
   batch's earlier insert and answers `500 storage_failed`; the retry then stores everything (test). The routing log
   lines are written after the commit, so a rolled-back batch logs nothing. The transaction times out at 4 s, under
   HubSpot's 5 s. Answer times through `next start`: 232 ms for the first (cold) request, then 29–80 ms (`01`, `03`);
   a 100-event batch in the test suite stays under its 2 s assertion.
3. **Signature v3 is unchanged:** tampered body → 401 `signature_mismatch`, 301 s old → 401 `timestamp_too_old`,
   URL-encoded query string → 200 (`01` step 4, and the unit tests).
4. **Routing.** `object.creation` with `objectTypeId 0-1` → `triage`; every other event → one log line with its decision
   and reason, no job (`server-logs.txt`). The rule is one function, `routeCrmEvent` in `@repo/queue`.
5. **The `hubspot_direct` Lead is made by the worker, not the webhook** (`02`): one refresh-token grant, one
   `GET /crm/objects/2026-09/contacts/610000000001?properties=…` with the new access token, a Lead with source
   `hubspot_direct`, the creation event linked to it, the job `completed` with `{outcome: created}`, and
   `oauth_token.last_refreshed_at` set. Tests also cover: a second job is `exists` with no HubSpot read; a contact with a
   non-reserved email, no email or a 404 completes as `skipped` and stores nothing; a HubSpot 5xx, a portal with no
   install or a malformed job throws, so pg-boss retries it. No email appears in any log line.
6. **Privacy deletion** (`03`): purged once (`purged 1`), its retry a duplicate (`purged 0`); the row stays with every
   PII column null, `pii_purged_at` set and the deletion event linked. A second deletion event finds it already purged;
   a late lead upsert finds the row and never refills it; a deletion that arrives before any Lead makes the later upsert
   skip (`privacy_deleted`). The purge and the upsert hold the same per-contact advisory lock, so they can't interleave.
7. **Token refresh** (`token-manager.test.ts`): the documented grant fields; the cached token is served until 5 minutes
   before expiry (at most half the lifetime); ten concurrent callers make one request; a different refresh token from
   HubSpot is stored encrypted; a hung token endpoint is `unknown`, recorded as such, nothing cached, and the next call
   asks again; `400 BAD_REFRESH_TOKEN` is `rejected` with HubSpot's codes recorded and no token; an answer for another
   portal is refused. Under OAuth a 401 drops the cached token and retries once with a fresh one; a second 401 is
   returned as HubSpot's answer.
8. **Data minimisation:** the contact read sends only `CONTACT_READ_PROPERTIES` and returns only those (HubSpot's
   `hs_object_id`, `createdate` and anything else are dropped); asking for another property throws before any request.
9. **Contract fixtures** (`packages/crm-hubspot/fixtures/api`, `source: docs`): contact 200 and 404, both token grants,
   `BAD_REFRESH_TOKEN`. The tests read their expectations from the fixture, so a recording can replace a file as is.
10. **Mapping (draft):** every `triage_disposition` value, against every `changeSource` including `CRM_UI`, never maps to
    a primary action; a primary rule needs a person's change and fails closed otherwise.
11. **Schema:** one additive migration (`prisma-migrate.txt`); a second `migrate dev` finds no drift. The purge CHECK now
    includes `company_name` and `job_title`, which Phase 2's left out.
12. **Stateless callbacks** (ADR 0006): no `state` and an unknown portal → 403 page, nothing stored; a portal in
    `HUBSPOT_KNOWN_PORTAL_IDS` or already installed → stored as `hubspot_initiated`; an empty or wrong `state` → refused
    before any exchange (tests).
13. **The `prod` app** matches `dev` except for names, uids, description, redirects and target URL (test).

## Assumed: the UNVERIFIED list

Each is marked `// UNVERIFIED (live check pending)` (or in the fixture's `note`) where the code relies on it.

| Where                                                          | Assumption                                                                                    | What the code does if it's wrong                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `oauth.ts` (crm-hubspot), `oauth-token.refresh_token.200.json` | a refresh answer has the same fields as the code exchange's                                   | `hub_id`, `scopes`, `refresh_token` are optional; a missing one is no error |
| `token-manager.ts`                                             | whether HubSpot ever rotates the refresh token                                                | a different one is stored; the same one is no rotation                      |
| `oauth-token.refresh_token.400.json`                           | a revoked refresh token answers HTTP 400 (the docs give the body, not the status)             | any 4xx is `rejected`                                                       |
| `api.ts`                                                       | an expired access token answers 401                                                           | the client relies on the status, not the body                               |
| `contact-read.ts`, `contacts-get.404.json`                     | a missing contact answers 404; a merged contact's old ID may answer with the surviving record | 404 is `null`; a different `id` is `skipped: contact_merged`                |
| `routing.ts`                                                   | `object.creation` carries `objectTypeId`                                                      | without it the event is logged, not routed                                  |
| `conversion-mapping.ts`                                        | the `changeSource` values a person's edit carries (`CRM_UI`, …)                               | unknown sources never map to a primary action                               |
| `apps/web/lib/hubspot/oauth.ts`, ADR 0006                      | HubSpot's Install button sends no `state` rather than an empty one                            | an empty one is refused as `state_missing`                                  |

Still open from Spike C (unchanged): `subscriptionType` vs `eventType`, the payload fields of `object.creation`, and
whether a project build accepts the `triage_disposition` subscription before the property exists.

## Changes to PLAN 3.3 (for the coordinator)

- The `hubspot_direct` Lead upsert moved from the webhook to the worker's `triage` job: the payload has no email, and the
  receiver must not call HubSpot inline. So a contact created while the Mac is off gets its Lead row when the worker
  next runs, not at webhook time.

## Blocked on Zain

Needs the HubSpot account and the `demo` test account (Phase 0), and the Spike C runbook steps 1–7 (`cloudflared`,
`hs account auth`, upload `dev`, client ID and secret in `.env`). Save outputs to `docs/evidence/phase-3/live/`, with
tokens, secrets, emails and the signature header redacted.

1. **Live install into `demo`** (`dev` app). Start `next start` with the real credentials and open
   `http://localhost:3100/api/hubspot/oauth/start`; choose `demo`. Expect `{"ok":true,"portalId":"<demo>"}` and an
   `oauth_token` row with `installed_via = app_start`. If the picker doesn't offer `demo`, put demo's portal ID in
   `HUBSPOT_KNOWN_PORTAL_IDS`, restart, and use the Distribution tab → _Test installs_; expect `installedVia:
   hubspot_initiated`. Save the callback's raw query parameter names (not values): does it carry `state` at all?
2. **A refresh against HubSpot.** With the install stored, run the worker's handler once for a seeded contact (a
   `triage` job from step 3, drained like `offline-worker-run.ts` but without the fakes and with the real
   `TOKEN_ENCRYPTION_KEY`), or wait for step 3's job. Record: the refresh answer's field names (are `hub_id`, `scopes`,
   `refresh_token` there; is the refresh token the same?), and `oauth_token.last_refreshed_at`. Then turn the answer into
   `fixtures/api/oauth-token.refresh_token.200.json` with `source: recording` (tokens replaced by same-shape placeholders).
3. **First live webhooks.** With the tunnel up and `PUBLIC_WEBHOOK_URL` set to it, wait 5 minutes after the upload,
   then in `demo`: create a contact with a reserved-domain email, change its lifecycle stage, then delete it with
   _Permanently delete_ (GDPR). Expect: one `crm_event` per event, one `triage` job, the Lead after the drain, and the
   purge after the deletion. Save the `HUBSPOT_WEBHOOK_CAPTURE_DIR` files and answer: `objectTypeId` on
   `object.creation`; the `changeSource` of a UI edit; the privacy deletion's exact `subscriptionType` and fields;
   `attemptNumber` on a retry (stop the server for two minutes during a change).
4. **Recordings.** Replace `contacts-get.200.json` and, if one happens, `contacts-get.404.json` with recordings from
   steps 2–3. If any contract test then fails, keep the recording and fix the code, not the fixture.
5. **The `prod` app** once the Vercel `web` project exists: replace the placeholder URL in `integrations/hubspot-app/prod`,
   upload, and test-install into `demo` from `https://<production web>/api/hubspot/oauth/start`.
