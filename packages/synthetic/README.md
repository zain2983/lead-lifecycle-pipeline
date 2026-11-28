# @repo/synthetic

Seeded, deterministic synthetic data: the same seed gives the same bytes on any machine. Every name in it is
invented. Every domain is reserved: `<name>.example.com` for sites and companies, `example.com`, `example.org`
and `example.net` for personal and bulk mail. Not `*.test`: HubSpot rejects those emails (`INVALID_EMAIL`), and
only spam message text still mentions `.test` hosts. Every phone number is `+1 201-555-01xx` (NANP's fictional 555-0100 to 555-0199 block, under one area
code, so each is a valid 10-digit number nobody owns). Tests fail on any other domain or phone format.

```sh
pnpm --filter @repo/synthetic generate --seed 42 --summary   # keys, scenarios, intended labels, sha256
pnpm --filter @repo/synthetic generate --seed 42 --set eval  # the eval fixtures as JSON
```

## What it holds

| Piece                | Contents                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sites                | `saas` (B2B SaaS) and `rehab` (`sensitive: true`) get demo sites in Phase 9. `clinic` and `local_services` exist only as fixtures. All of them stamp leads in Asia/Karachi. |
| Companies            | 12 fictional companies, including subsidiaries (`parentKey`) and duplicate records of the same company under another spelling or domain (`duplicateOfKey`).                 |
| `demoLeads(seed)`    | 20 leads for the `demo` HubSpot account: 15 SaaS and 5 rehab, inside 2026-10-26 to 2026-11-08 UTC. That window spans the US DST change on 2026-11-01.                       |
| `evalFixtures(seed)` | 10 fixture leads for the `eval` HubSpot account (see below).                                                                                                                |

Each lead carries its form answers and a session handle. It also has a browser event ID, consent state (Consent
Mode v2 `ad_user_data` and `ad_personalization`, plus GPC) and a click with the channel's own click ID. Its times
come in UTC, in the site's zone and in the Ads account's zone (America/New_York), plus the UTC report date. Each
lead also carries its **intended label**.

## Intended labels

The label is decided here, by rule, so Phase 6 can use these leads as eval cases. A model never produced it.

| Scenario         | `triageDisposition` | Correction (provisional, Phase 12) | Why                                                                                |
| ---------------- | ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| `qualified`      | qualified           | keep                               | fits the target profile and asked to meet or buy                                   |
| `nurture`        | nurture             | keep                               | real prospect, only exploring                                                      |
| `spam`           | spam                | retract                            | promotion; instructions inside the message (prompt injection) are ignored          |
| `test`           | spam                | retract                            | internal test submission; the label set has no `test`, and a test must never count |
| `duplicate`      | duplicate           | retract                            | same name and phone as an earlier lead, another email                              |
| `out_of_area`    | needs_review        | hold                               | outside the service area; a person decides on a referral                           |
| `auto_dq_score`  | nurture             | keep                               | B2B score below `AUTO_DQ_THRESHOLD` (25)                                           |
| `no_show`        | qualified           | keep                               | qualified at triage; booked and didn't show (`salesOutcome`)                       |
| `partial_refund` | qualified           | restate                            | qualified at triage; won, then a quarter refunded (`salesOutcome`)                 |

B2B labels follow `saasScenarioFromAnswers`: a score below 25 means auto-DQ; otherwise a lead still exploring is
nurture; everything else is qualified. Keys (`s42-demo-07`) never reveal the scenario, because they reach HubSpot
as `fixture_key`.

## Why the eval set has 10 leads

The `eval` HubSpot account holds the contacts that live checks run against: the Phase 5 end-to-end run and the
Phase 7 upstream PR's "create, upsert again, assert one record" report. Phase 6's 80 labelled cases don't need to be
in HubSpot, because eval runs always send a snapshot. So the set is the smallest one that still covers everything:

- one lead for each of the seven disposition cases;
- a qualified lead at a **subsidiary**, which is also the original the duplicate points at (through a **duplicate
  company** record);
- a nurture lead with a **personal email domain** and GPC on;
- a qualified lead in the **sensitive** vertical, with health words in its message.

Together they cover every triage label (qualified ×4, nurture ×2, spam ×2, duplicate, needs_review) and all four
verticals. The spam lead also carries a prompt injection. Their times are pinned to the clock traps:

- a Karachi date that differs from the UTC date, and a New York date that differs from the UTC date;
- a submission at exactly local midnight;
- two clicks at 01:30 New York time on 2026-11-01, one in EDT and one in EST.

Ten contacts fit in one batch request, which keeps every run far below HubSpot's rate limits.
