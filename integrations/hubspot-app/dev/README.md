# HubSpot project: `dev`

The developer-platform project for the development app. Written by hand from HubSpot's docs (platform version
`2026.09`, the newest on 2026-11-27), not generated with `hs project create`. `hs project upload` sends only `src/`.

| File | What it sets |
|---|---|
| `hsproject.json` | project name, `srcDir`, `platformVersion: "2026.09"` |
| `src/app/app-hsmeta.json` | the app: `distribution: "private"`, `auth.type: "oauth"` (installs only into allowlisted accounts, at most 10), redirect URLs, required scopes |
| `src/app/webhooks/webhooks-hsmeta.json` | `targetUrl`, `maxConcurrentRequests` (must be more than 5) and the subscriptions |

Subscriptions (PLAN Phase 3 step 4):

- `crmObjects`: contact `object.creation` (payloads say `subscriptionType: "object.creation"`, `objectTypeId: "0-1"`);
- `legacyCrmObjects`: `contact.propertyChange` for `lifecyclestage`, `hs_lead_status` and `triage_disposition`, and
  `deal.propertyChange` for `dealstage`;
- `hubEvents`: `contact.privacyDeletion` (the `object.*` format doesn't support it).

Things to know before uploading:

- **Two placeholders.** `targetUrl` must be replaced with the quick-tunnel URL before each live test, and the second
  redirect URL with the production URL once the Vercel `web` project exists. Don't commit a tunnel URL.
- **Scopes are duplicated on purpose** in `HUBSPOT_REQUIRED_SCOPES` (`packages/crm-hubspot/src/oauth.ts`), which the
  install URL sends. A test fails if the two lists differ.
- **`triage_disposition` doesn't exist until Phase 2** (`pnpm hs:setup`). HubSpot's webhooks guide says a
  property-change subscription for a property an account doesn't have "will not result in any notifications", which
  suggests the build won't fail. That is unverified for project builds: see the runbook.
- Changing a `uid` later makes HubSpot treat the component as new.

Runbook for the live test, and what has and hasn't been verified: [`docs/evidence/spike-c/README.md`](../../../docs/evidence/spike-c/README.md).
