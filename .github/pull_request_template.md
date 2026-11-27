## What and why

<!-- One or two sentences. Link the plan phase/step, e.g. "Phase 3, step 3". -->

## How I checked it

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] Evidence added to `docs/evidence/` (redacted) if this touches a real platform
- [ ] ADR added or updated if this changes a decision

## Rules

- [ ] Synthetic data only; no secrets, tokens or real PII in the diff
- [ ] No platform result is mocked and presented as live
