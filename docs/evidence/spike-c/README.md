# Spike C: HubSpot, offline half (PLAN Phase 1, step 6)

- **Date:** 2026-11-27. **Branch:** `spike/hubspot`. **Machine:** macOS, Node 26.5.0 locally (CI uses 24), pnpm 11.21.0.
- **Scope:** everything that doesn't need a HubSpot account. No HubSpot account exists yet, so **no request in this
  folder came from or went to HubSpot.** The client secret, client ID and encryption key used here are synthetic local
  values in the git-ignored `.env`. The token endpoint in the OAuth run is a local fake (`fake-token-endpoint.mjs`).
- **Result:** offline half done; the live half is **Blocked on Zain** (runbook below).

## Files

| File                                            | What it is                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webhook-replay-transcript.txt`                 | `pnpm hs:replay` and one `curl` against `next start --port 3100` (production build, commit `2c47470`): 8 cases                                   |
| `oauth-transcript.txt`                          | `/api/hubspot/oauth/start` and `/callback` against the production build with a local fake token endpoint; the stored row; an independent decrypt |
| `server-logs.txt`                               | the server's own log lines for both runs, plus the fake endpoint's request log (LAN IP redacted)                                                 |
| `capture-example-forged-401.json`               | one delivery saved by `HUBSPOT_WEBHOOK_CAPTURE_DIR` (signature redacted)                                                                         |
| `next-build.txt`                                | `next build` output (built without any HubSpot variable set)                                                                                     |
| `prisma-migrate.txt`                            | `prisma migrate dev --name oauth_token` and `prisma migrate status` against `spike_hubspot`                                                      |
| `parse-project-output.txt`, `parse-project.mjs` | the HubSpot CLI's own parser reading `integrations/hubspot-app/dev` offline                                                                      |
| `unit-tests.txt`                                | verbose Vitest output: 36 tests in `crm-hubspot`, 20 in `web`, 5 in `core`                                                                       |
| `fake-token-endpoint.mjs`                       | the local stand-in for `https://api.hubapi.com/oauth/v3/token` used in the OAuth run                                                             |

## How it was produced

```sh
pnpm install
pnpm db:up                                    # shared llp-postgres-1 on :5433; this agent uses spike_hubspot
cd packages/db && pnpm exec prisma migrate dev --name oauth_token && cd ../..
pnpm db:generate
pnpm lint && pnpm typecheck && pnpm test
cd apps/web && pnpm exec next build
# Next read .env from apps/web only, so the repo-root .env was exported by hand (next.config.ts loads it now):
set -a && . ../../.env && set +a && HUBSPOT_WEBHOOK_CAPTURE_DIR=/tmp/llp-captures pnpm exec next start --port 3100
# in another shell, from the repo root:
pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json
pnpm hs:replay packages/crm-hubspot/fixtures/contact-lifecyclestage-change.json
pnpm hs:replay packages/crm-hubspot/fixtures/batch-mixed.json
pnpm hs:replay packages/crm-hubspot/fixtures/contact-lifecyclestage-change.json --tamper --expect 401
pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json --age 301 --expect 401
pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json --url 'http://localhost:3100/api/webhooks/hubspot?env=dev&next=https%3A%2F%2Fapp.example.test%2Fdone%3Fa%3D1&tags=a%2Cb'
pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json --url http://127.0.0.1:3100/api/webhooks/hubspot
# case 8 (forged Host) is the curl shown in the transcript.

# OAuth run: start the fake, then restart the server pointing at it.
node docs/evidence/spike-c/fake-token-endpoint.mjs 3199
HUBSPOT_OAUTH_TOKEN_URL=http://127.0.0.1:3199/oauth/v3/token pnpm exec next start --port 3100   # with .env exported
curl -i http://localhost:3100/api/hubspot/oauth/start
curl -i -H 'Cookie: hs_oauth_state=<state>' 'http://localhost:3100/api/hubspot/oauth/callback?code=synthetic-code-0001&state=<state>'
```

## Verified (offline)

1. **Signature v3 matches HubSpot's own published example.** The Java tab of the request-validation page gives a secret,
   URI, body, timestamp and signature; `verifySignatureV3` accepts it (`unit-tests.txt`). The algorithm is base64
   HMAC-SHA256 of `method + uri + rawBody + timestamp`, with the 5-minute window.
2. **Through the production build** (`webhook-replay-transcript.txt`): signed fixtures → **200** with the event count
   (1, 1, 4), in 27–54 ms; body changed after signing → **401** `signature_mismatch`; timestamp 301 s old → **401**
   `timestamp_too_old`; encoded query string → **200**; request arriving under another Host but signed for
   `PUBLIC_WEBHOOK_URL` → **200**; request signed for the Host it sends → **401**.
3. **Unit tests** cover a bad signature, old and future timestamps (±5 min, with the boundary), URL-encoded query
   strings (exactly HubSpot's twelve characters, query only, uppercase only), tampered body, missing headers, and raw body
   vs `JSON.stringify` (HubSpot's Node sample re-serialises the parsed body; a pretty-printed body proves that fails).
4. **`next start` builds `request.url` from its own host and port, not from the Host header.** In the forged case the
   request carried `Host: attacker.example.test` and `X-Forwarded-Host: attacker.example.test`, yet `request.url` was
   `http://localhost:3100/...` (`capture-example-forged-401.json`). Behind `cloudflared`, HubSpot signs
   `https://<tunnel>/...` while `request.url` would say `http://localhost:3100/...`, so verifying against
   `request.url` would reject every live delivery. Building the URI from `PUBLIC_WEBHOOK_URL` is what makes it work.
5. **OAuth against the production build and real Postgres** (`oauth-transcript.txt`): `/start` → 302 to
   `https://app.hubspot.com/oauth/authorize` with `%20`-separated scopes and an `HttpOnly; SameSite=Lax` state cookie
   scoped to `/api/hubspot/oauth`; forged state → 400 **without** calling the token endpoint; good callback → 200 with
   portal ID and scopes, **no token in the response**; the fake endpoint received the five documented form fields as
   `application/x-www-form-urlencoded`; token endpoint 400 → 502 carrying the body exactly as it came back. The
   `oauth_token` row holds a 37-byte ciphertext, 12-byte IV and 16-byte tag; the token text is not in the ciphertext;
   plain `node:crypto` decrypts it with the key and `hubspot-refresh-token:v1:<portal>` as associated data, and
   rejects another portal's AAD and a wrong key.
6. **Token crypto** (unit tests): round trip, fresh IV per call, tampered ciphertext, tag or IV fail, wrong key fails,
   ciphertext moved to another portal's row fails.
7. **Prisma:** `migrate dev --name oauth_token` created and applied `20261127164438_oauth_token` on `spike_hubspot`;
   `migrate status` says up to date. Prisma 7 did not run `generate` by itself; `pnpm db:generate` is a separate step.
8. **The HubSpot CLI's parser reads the project offline** (`parse-project-output.txt`): `hsproject.json` validates,
   `2026.09` is a known platform version, and both components (`APPLICATION`, `WEBHOOKS` depending on the app) parse
   into the intermediate representation that `hs project upload` sends. Schema validation was skipped (next section).
9. **`next build` needs no HubSpot variables**: every route reads env at request time.

## Assumed, not verified (the live run must confirm)

- **Schema validation of the hsmeta files.** `hs project validate` stops with "Config file not found, run hs account
  auth": the CLI downloads the component schemas from HubSpot per account
  (`project-components-external/project-schemas/v3/2026.09`). The files follow the docs' examples field for field.
- **`triage_disposition` before the property exists.** HubSpot's webhooks guide: "If a customer's account doesn't have
  the property you specify in a subscription, you will not get any webhooks from that customer for that property."
  That reads as "no error, no events", but it is written for the legacy subscription API. Whether a project build
  accepts it is unknown until the first upload.
- **The payload field names.** The guide's example JSON says `eventType`; its field table and the signature example say
  `subscriptionType` (the schema requires `subscriptionType`). The generic-webhooks table calls the timestamp `label`;
  every example says `occurredAt`. Fixtures use `subscriptionType` and `occurredAt`.
- **What HubSpot signs when the target URL has an encoded query.** The docs say to decode the twelve characters before
  comparing, which implies HubSpot signs the decoded form. Our `targetUrl` has no query, so this only matters if one
  is added.
- **Lowercase escapes** (`%3a`) are left as they are, as in HubSpot's three samples.
- **IDs fit in a JavaScript number.** `objectId` values in the docs are around 1.4 × 10¹¹, far below 2⁵³.
- **The authorize URL offers developer test accounts in its account picker.** See the runbook, step 8.
- **`hub_id` is present in the v3 token response.** It is in the docs' example; the code refuses a response without it
  (502) rather than guess.

## Blocked on Zain: the live half

Everything below needs a logged-in HubSpot user. Prerequisite (PLAN Phase 0): a HubSpot account with the developer
test account `demo`. Run from the repo root unless a step says otherwise; save outputs in `docs/evidence/spike-c/live/`
and redact secrets, emails and the signature header (keep 6 characters).

1. **Install `cloudflared`:** `brew install cloudflared`, then `cloudflared --version`. Quick tunnels need no
   Cloudflare account.
2. **Authenticate the CLI** (pinned, no global install): `pnpm exec hs account auth`. It opens the browser for a
   personal access key. `hs init` still exists in CLI 8.19.0 but is marked "[DEPRECATED] … Replaced by
   `hs account auth`".
3. **Validate:** `cd integrations/hubspot-app/dev && pnpm exec hs project validate --json > ../../../docs/evidence/spike-c/live/validate.json`.
   Exit code 2 means a warning; keep the output either way.
4. **Start the tunnel:** `cloudflared tunnel --url http://localhost:3100` and copy the `https://<words>.trycloudflare.com`
   URL it prints. Leave it running. The hostname changes every run.
5. **Point both sides at it** (don't commit these edits):
   - `integrations/hubspot-app/dev/src/app/webhooks/webhooks-hsmeta.json`:
     `"targetUrl": "https://<words>.trycloudflare.com/api/webhooks/hubspot"`;
   - `.env`: `PUBLIC_WEBHOOK_URL=` the same URL, and `HUBSPOT_WEBHOOK_CAPTURE_DIR=/tmp/llp-hubspot-captures`.
6. **Upload:** `cd integrations/hubspot-app/dev && pnpm exec hs project upload --json`. Confirm creating the project.
   If the output has no `deployId`: `pnpm exec hs project deploy --build <buildId> --json`. Check with
   `pnpm exec hs project list-builds --limit 1 --json`. **If the build fails on `triage_disposition`**, save the error
   verbatim, set that subscription's `"active": false`, upload again, and note it for Phase 2.
7. **Client credentials:** `pnpm exec hs project open` → under _Project Components_ click
   **lead-lifecycle-pipeline (dev)** → **Auth** tab → copy _Client ID_ and _Client secret_ into `.env`
   (`HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`), replacing the synthetic offline values. Leave
   `HUBSPOT_OAUTH_TOKEN_URL` unset.
8. **Install into `demo`.** Developer test accounts are not on the allowlist: HubSpot's docs say private OAuth apps
   install into "up to 10 allowlisted accounts (not including developer test accounts)", and the _Add approved
   account(s)_ panel lists production accounts. Start the install from our app instead, so the callback gets its
   `state`:
   - build and start: `pnpm --filter @repo/web build && pnpm --filter @repo/web start` (`next.config.ts` loads the
     repo-root `.env`; a variable exported in the shell wins over the file);
   - open `http://localhost:3100/api/hubspot/oauth/start` in the browser that is signed in to HubSpot, choose
     **demo**, review the scopes, tick the unverified-app box and click **Connect app**;
   - expect `{"ok":true,"portalId":"<demo>", …}`. Save it, plus the row query from `oauth-transcript.txt`.
   - If the picker doesn't offer `demo`, use the Distribution tab → _Test installs_ → **Add test install(s)** →
     **Install** instead. HubSpot then calls our callback **without our state**, so it will answer
     `400 state_missing` by design and store nothing. Save that response; Phase 3.1 decides how to accept
     HubSpot-initiated installs.
9. **Check the signature path with the real secret**, before HubSpot sends anything:
   `pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json` (posts through the tunnel) and
   `pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json --url http://localhost:3100/api/webhooks/hubspot`.
   Both must answer 200.
10. **Wait 5 minutes** after the deploy: HubSpot caches webhook settings for up to five minutes.
11. **Make a change in `demo`:** create a contact with a reserved-domain email (for example `spike-c-live@example.com`),
    then change its **Lifecycle stage** (for example to _Marketing Qualified Lead_). Expect an `object.creation` and a
    `contact.propertyChange` / `lifecyclestage` delivery, possibly in one batch.
12. **Capture:** copy the files from `/tmp/llp-hubspot-captures/` into `docs/evidence/spike-c/live/` (redact the
    signature header and the email), and the server's `hubspot webhook accepted` lines. Optionally turn one into a
    fixture: `jq -r .rawBody <file> | jq . > packages/crm-hubspot/fixtures/live-<name>.json`.
13. **Answer the open questions** in `live/README.md`: did the build accept `triage_disposition`; `subscriptionType`
    or `eventType`; which fields `object.creation` carries; did v3 verify through the tunnel (200); which other
    signature headers arrived (`X-HubSpot-Signature-Version`, v1/v2); the delay from `occurredAt` to `receivedAt`.
    Optional: stop the server for two minutes during a change and look for `attemptNumber: 1` on the retry.
14. **Clean up:** stop the tunnel, `git checkout integrations/hubspot-app/dev/src/app/webhooks/webhooks-hsmeta.json`,
    remove `HUBSPOT_WEBHOOK_CAPTURE_DIR` from `.env`.

## Docs read on 2026-11-27

[Request validation](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/request-validation)
(modified 2026-07-01) ·
[Configure webhooks](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks) ·
[App configuration](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/app-configuration)
(2026-11-23) · [Developer platform overview](https://developers.hubspot.com/docs/apps/developer-platform/overview)
(v2025.2, v2026.03, v2026.09) ·
[Migrate to 2026.09](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/migrate-an-app/migrate-to-the-latest-platform-version) ·
[Create an app](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/create-an-app) ·
[Manage apps](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot) ·
[OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)
(`/oauth/v3/token`) · [Webhooks guide](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide) ·
[Generic webhooks](https://developers.hubspot.com/docs/apps/legacy-apps/public-apps/create-generic-webhook-subscriptions).
npm on the same day: `@hubspot/cli` latest 8.19.0 (depends on `@hubspot/project-parsing-lib` 0.23.7).
