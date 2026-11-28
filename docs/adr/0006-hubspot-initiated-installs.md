# 0006. HubSpot-initiated installs: accept them only for a known portal

- **Status:** accepted (offline; the live install is listed in `docs/evidence/phase-3/README.md`)
- **Date:** 2026-11-28
- **Numbering:** 0004 and 0005 are reserved for the Phase 8 ADRs (Data Manager, routing policy), so this is 0006.

## Context

Every install is meant to start at `/api/hubspot/oauth/start`. That sets a one-time `state` cookie, and the callback
refuses any `state` that doesn't match it (Spike C): this is the standard defence against a forged callback that would
link someone else's HubSpot account to this deployment.

HubSpot can also start an install itself: the app's Install button, and the Distribution tab's _Test installs_. Those
redirect to our callback with a `code` and **no `state` parameter at all**. Developer test accounts can't be put on a
private app's allowlist, so a test install may be the only way to install into `demo` if HubSpot's account picker
doesn't offer it (Spike C runbook, step 8). With the strict check alone, that install answers `400 state_missing` and can
never succeed.

The callback can't tell which portal is installing until it exchanges the code: only the token response carries
`hub_id`.

## Options

1. **Always refuse a callback without `state`.** Safest, but it may make the `demo` install impossible.
2. **Accept any callback without `state`.** Lets anyone who can reach the install flow attach their portal. The app is
   privately distributed, so HubSpot limits who can install, but test accounts and whoever HubSpot lets in would be
   accepted without any check of ours.
3. **Accept it only for a portal this deployment already knows**: one listed in `HUBSPOT_KNOWN_PORTAL_IDS`, or one that
   already has an install stored (a reinstall). Anything else is refused with a page that says what to do.

## Decision

Option 3.

- A callback **without a `state` parameter** exchanges the code, then checks the `hub_id`. If it's known, the install is
  stored with `installed_via = 'hubspot_initiated'`. Otherwise the tokens are dropped, unstored, and the browser gets a
  `403` page naming the account and the two ways forward: start at `/api/hubspot/oauth/start`, or add the ID to
  `HUBSPOT_KNOWN_PORTAL_IDS` and install again.
- A callback whose `state` is **present** keeps the strict check: empty, wrong, or without its cookie is refused before
  any exchange. A missing parameter is the only signal for the HubSpot-initiated path, so a forged or stale `state` can
  never fall back to it.
- `oauth_token.installed_via` records which path made the row (`app_start` or `hubspot_initiated`, checked in SQL).

## Consequences

- To use HubSpot's button for `demo`, put demo's portal ID in `HUBSPOT_KNOWN_PORTAL_IDS` first. The ID is shown in
  HubSpot's account menu, and in the rejection page itself.
- The code for an unknown portal is spent and its tokens discarded. HubSpot may still list the app as installed there:
  the page says to uninstall it in HubSpot. Webhooks from that portal still verify (they are signed with our app's
  secret) and are stored, but the worker has no token for them, so their triage jobs fail and retry until Phase 4's
  dead-letter queue holds them, where they are visible.
- A stateless reinstall into a known portal replaces its refresh token, like any reinstall.
- What stays unverified until the live install: that HubSpot's button sends no `state`, rather than an empty one (an
  empty one would be refused as `state_missing`; the fix would be to treat it like a missing one).
