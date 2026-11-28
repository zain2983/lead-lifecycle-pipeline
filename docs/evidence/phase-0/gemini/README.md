# Gemini free key: checked and stored in Sim (Phase 0, brief 54)

Run on 2026-11-28 on the author's Mac. The key came from the main checkout's root `.env` (`GEMINI_API_KEY`), was read
only inside the commands that used it, and is not in any file here. Redaction: any Google API key pattern (the `AI` prefix followed by
the key body) is replaced with `[REDACTED]` in every saved output.

## What ran

| Step        | Command (key sent in the `x-goog-api-key` header, never in the URL)                                                                                                                                                                                                                                                                   | Output file         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1. Models   | `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`                                                                                                                                                                                                                                                            | `01-models.txt`     |
| 2. One call | `POST …/v1beta/models/gemini-3.5-flash-lite:generateContent` with `"Reply with the single word ok."`                                                                                                                                                                                                                                  | `02-call.txt`       |
| 3. Into Sim | Sim v0.9.66 started with `docker compose -f infra/sim/docker-compose.yml up -d --wait` from the main checkout. `sim secrets set GEMINI_API_KEY --scope workspace --value @-` with the value piped on stdin from the root `.env` (no trailing newline, not an argument). `sim secrets list`. Sim stopped with `docker compose … stop`. | `03-sim-secret.txt` |

## Model IDs

- **Used:** `gemini-3.5-flash-lite` (3.5 Flash-Lite is listed, so the brief's fallback to 3.1 was not needed).
- Also listed: `gemini-3.1-flash-lite`, `gemini-3.1-flash-lite-preview`, `gemini-flash-lite-latest`,
  `gemini-2.5-flash-lite`. Each has a 1,048,576-token input limit and a 65,536-token output limit.
- The list has 65 models in total; `01-models.txt` keeps only the `flash-lite` names.

## Call result

- HTTP **200**. Reply text: `ok`. `finishReason: STOP`. `modelVersion: gemini-3.5-flash-lite`.
- `usageMetadata`: prompt 7 tokens, candidates 1, total 8. `serviceTier: standard`.
- Response headers are in `02-call.txt`, redacted.
- One call only was made against generateContent. The free limits were not tested.

## Sim

- `sim secrets set` returned the metadata only (name, scope, description, `unredacted: false`), not the value.
- `sim secrets list` shows one workspace secret, `GEMINI_API_KEY`, with `role: admin` and no value.
- The `createdAt` on the list (16:55:51Z) is earlier than this session's write (`updatedAt` 16:58:20Z). I did not check
  who wrote the first timestamp. The Sim instance is local and may have been used by another session.
- Sim's redaction is on (`unredacted: false`), so the key is hidden in run logs.

## Free limits: verified vs assumed

| Item                                                                                                         | Status                                                                                |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 3.5 Flash-Lite exists and answers a call with the key                                                        | **Verified** (`02-call.txt`)                                                          |
| Token limits (1,048,576 in / 65,536 out)                                                                     | **Verified** (`01-models.txt`)                                                        |
| Free-tier limits: 15 requests a minute, 250K tokens a minute, 500 requests a day, for 3.5 and 3.1 Flash-Lite | **Assumed**. Zain read them in AI Studio. The models API does not return RPM/TPM/RPD. |
| Billing is off for the project                                                                               | **Assumed** (per Zain). The API cannot check billing state.                           |
| The key is stored and readable by Sim's agent block                                                          | **Not checked**. It needs a Phase 5 workflow that uses `{{GEMINI_API_KEY}}`.          |

## Repo changes

- `.env.example`: `GEMINI_API_KEY=` with a comment, and a runtime-matrix row (Sim column only). It is local only,
  copied once into Sim's workspace secrets, never on Vercel or GitHub.
- `packages/core/src/env.ts` is not changed: no repo code reads this variable.
- `docs/evidence/spike-b/README.md`: the Gemini item under "Blocked on Zain" is marked done, with a link here.
