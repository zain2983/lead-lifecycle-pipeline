# HubSpot project: `prod`

The same app as [`dev`](../dev/README.md), for the production `web` deployment. Same platform version, scopes and
subscriptions; a test (`packages/crm-hubspot/test/oauth.test.ts`) fails if the two drift anywhere else.

|                      | `dev`                                           | `prod`                                                                                 |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Project name         | `lead-lifecycle-pipeline-dev`                   | `lead-lifecycle-pipeline-prod`                                                         |
| Component `uid`s     | `llp_dev_app`, `llp_dev_webhooks`               | `llp_prod_app`, `llp_prod_webhooks`                                                    |
| `redirectUrls`       | localhost:3100 and the production URL           | **the production URL only**                                                            |
| `targetUrl`          | the quick-tunnel URL, set before each live test | **the production URL**                                                                 |
| Client ID and secret | in the local `.env`                             | in Vercel's environment for `web` (and the worker's `.env` when it refreshes for prod) |

Each project is its own app in HubSpot, with its own client ID, client secret and installs. So the webhook signature
(signed with the client secret) and the stored refresh tokens of one never work for the other: run `web` with the
credentials of the app whose `targetUrl` points at it.

**The production URL.** Both `redirectUrls` and `targetUrl` use `https://lead-lifecycle-pipeline.vercel.app`, the production
`web` deployment, since 2026-11-28 (it replaced `web-placeholder.example.com`). Upload is still pending: it needs Zain's
HubSpot login. Never point a `targetUrl` at a Vercel preview URL: previews are protected and would answer HubSpot with a
login page. `PUBLIC_WEBHOOK_URL` on Vercel must be exactly the `targetUrl`, or every delivery fails signature v3.

**Installing into `demo`** (PLAN Phase 3.1): open `https://<production web>/api/hubspot/oauth/start` and choose `demo`.
If HubSpot's picker doesn't offer it and you use the Distribution tab's _Test installs_ instead, the callback has no
`state`: add demo's portal ID to `HUBSPOT_KNOWN_PORTAL_IDS` first (docs/adr/0006-hubspot-initiated-installs.md).

Upload the same way as `dev` (`cd integrations/hubspot-app/prod && pnpm exec hs project upload --json`). Changing a
`uid` later makes HubSpot treat the component as new.
