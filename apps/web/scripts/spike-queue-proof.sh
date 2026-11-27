#!/usr/bin/env bash
# Spike A after() proof (PLAN Phase 1 step 4): `next build`, then `next start --port 3101`, then curl.
# Needs the local Postgres (`pnpm db:up`), Prisma migrations (`pnpm db:deploy`) and the pg-boss schema
# (`pnpm --filter @repo/queue migrate`). Run from anywhere: bash apps/web/scripts/spike-queue-proof.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3101
BASE="http://localhost:$PORT"
DB_URL="${DATABASE_URL:-postgresql://app:app@localhost:5433/spike_queue}"
LOG="$(mktemp -t spike-queue-server.XXXXXX)"
SERVER=""
step() { printf '\n== %s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
stop_server() {
  if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; fi
  SERVER=""
}
trap stop_server EXIT
start_server() { # $1 = SPIKE_ROUTES value ("" for unset)
  : >"$LOG"
  env -u SPIKE_ROUTES DATABASE_URL="$DB_URL" ${1:+SPIKE_ROUTES=$1} \
    node ./node_modules/next/dist/bin/next start --port "$PORT" >"$LOG" 2>&1 &
  SERVER=$!
  for _ in $(seq 1 60); do curl -sf "$BASE/api/health" >/dev/null && return; sleep 0.5; done
  cat "$LOG"; echo "server did not start"; exit 1
}
post() { curl -s -w ' HTTP %{http_code}\n' -X POST "$BASE/api/spikes/queue" -H 'content-type: application/json' -d "$1"; }
get() { curl -s -w ' HTTP %{http_code}\n' "$BASE/api/spikes/queue?id=$1"; }

step "next build"
node ./node_modules/next/dist/bin/next build 2>&1 | grep -E 'Next.js|Compiled|api/spikes|arning|rror'

step "1. SPIKE_ROUTES unset: the route must not exist"
start_server ""
post '{"key":"proof-off"}'
curl -s -o /dev/null -w 'GET HTTP %{http_code}\n' "$BASE/api/spikes/queue?id=00000000-0000-0000-0000-000000000000"
stop_server

step "2. SPIKE_ROUTES=1: POST enqueues in one transaction, after() drains"
start_server 1
KEY="proof-$(date -u +%s)"
RESPONSE="$(post "{\"key\":\"$KEY\"}")"; echo "$RESPONSE"
JOB="$(echo "$RESPONSE" | sed -n 's/.*"jobId":"\([0-9a-f-]*\)".*/\1/p')"
sleep 2
step "3. the job after the response was sent"
get "$JOB"

step "4. same key again: same deterministic job id, no second job"
post "{\"key\":\"$KEY\"}"
sleep 1
get "$JOB"

step "5. five concurrent POSTs (each request: its own pg-boss instance on the shared 2-connection pool)"
PIDS=()
for i in 1 2 3 4 5; do post "{\"key\":\"$KEY-c$i\"}" >"$LOG.c$i" & PIDS+=("$!"); done
wait "${PIDS[@]}" # only the curls: a bare `wait` would also wait for the server
cat "$LOG".c*
sleep 3
for f in "$LOG".c*; do get "$(sed -n 's/.*"jobId":"\([0-9a-f-]*\)".*/\1/p' "$f")"; done
rm -f "$LOG".c*

step "6. server log (spike lines)"
stop_server
grep '"spike":"queue"' "$LOG" || cat "$LOG"
rm -f "$LOG"
