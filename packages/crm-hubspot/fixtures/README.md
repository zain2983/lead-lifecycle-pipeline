# Synthetic HubSpot webhook fixtures

Hand-written, synthetic payloads shaped like HubSpot's documented webhook batches (a JSON array of events). No
event here came from a real HubSpot account: portal, app, subscription, object and user IDs are made up.

| File                                 | What it is                                                                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contact-creation.json`              | One contact `object.creation` event (the `crmObjects` subscription, so it carries `objectTypeId: "0-1"`).                                                       |
| `contact-lifecyclestage-change.json` | One classic `contact.propertyChange` event for `lifecyclestage`.                                                                                                |
| `batch-mixed.json`                   | Four events: `hs_lead_status` and `dealstage` changes, a **retry** of the lifecycle event (same `eventId`, `attemptNumber: 1`) and a `contact.privacyDeletion`. |

Field names follow the docs:
[webhooks guide](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide) (classic types) and
[generic webhook subscriptions](https://developers.hubspot.com/docs/apps/legacy-apps/public-apps/create-generic-webhook-subscriptions)
(`object.*` types, `objectTypeId`, `sourceId`). The docs disagree with themselves in two places, so a live delivery
(see `docs/evidence/spike-c/README.md`, Blocked on Zain) must confirm:

- the guide's JSON example uses `eventType` while its field table and the signature example use `subscriptionType`;
- the generic-webhooks field table calls the timestamp `label`; every example uses `occurredAt`.

The `contact.privacyDeletion` `changeSource` value is a guess; the docs show no example of that event.

Replay one with `pnpm hs:replay packages/crm-hubspot/fixtures/contact-creation.json`.

## `api/`: REST contract fixtures

One HubSpot exchange per file (`request` + `response`), used by `test/contracts.test.ts`. Today each is
`source: "docs"`: the shape of HubSpot's documented example, with synthetic values. To swap one for a recording, keep
the envelope, set `source: "recording"` and `recordedAt`, and paste the response as it came back (tokens replaced by
same-shape placeholders, emails by reserved-domain ones). The tests read their expectations from the file, so they
keep passing unless HubSpot's real shape differs from the docs; if one fails, fix the code, not the recording.
