#!/usr/bin/env bash
# Spike A kill test (PLAN Phase 1 step 4). A process fetches a job and is SIGKILLed mid-job; the job
# stays `active`; after its test-only expiry, `pnpm ops sweep --once` expires it to `retry`, works it
# again and completes it. Needs the local Postgres (`pnpm db:up`) and the pg-boss schema
# (`pnpm --filter @repo/queue migrate`). Run from anywhere: bash apps/worker/scripts/kill-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
EXPIRE="${EXPIRE:-5}"
LOG="$(mktemp -t kill-victim.XXXXXX)"
step() { printf '\n== %s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
show() { node --import tsx src/spikes/show-job.ts "$1"; }

step "1. victim: enqueue a spike-kill job (expireInSeconds=$EXPIRE), fetch it, hang"
node --import tsx src/spikes/kill-victim.ts "$EXPIRE" >"$LOG" 2>&1 &
PID=$!
for _ in $(seq 1 60); do grep -q '^FETCHED ' "$LOG" && break; sleep 0.5; done
cat "$LOG"
JOB="$(sed -n 's/^FETCHED \([0-9a-f-]*\).*/\1/p' "$LOG")"
[ -n "$JOB" ] || { echo "victim never fetched a job"; exit 1; }

step "2. kill -9 $PID (no shutdown hooks run, the job is never settled)"
kill -9 "$PID"
wait "$PID" 2>/dev/null || echo "victim exit status: $? (137 = SIGKILL)"

step "3. job row right after the kill"
show "$JOB"

step "4. sleep $((EXPIRE + 2)) s, past the expiry. No pg-boss supervisor runs anywhere, so nothing moves it"
sleep $((EXPIRE + 2))
show "$JOB"

step "5. pnpm ops sweep --once --budget 30"
pnpm --silent ops sweep --once --budget 30

step "6. job row after the sweep"
show "$JOB"
rm -f "$LOG"
