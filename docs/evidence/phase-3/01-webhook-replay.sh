#!/bin/zsh
# Run from the repo root with the server from `next start --port 3100` up.
export HUBSPOT_CLIENT_SECRET=synthetic-offline-secret-phase3
q() { echo "\$ psql -c \"$1\""; docker exec llp-postgres-1 psql -U app -d phase3 -c "$1"; }
step() { echo; echo "=== $1"; }
run() { echo "\$ $*"; "$@" 2>&1 | grep -v '^\$ \|^> \|^$'; echo "exit $pipestatus[1]"; }

echo "commit $(git rev-parse --short HEAD), $(date -u +%FT%TZ), database phase3 on localhost:5433"
step "0. Nothing stored yet for the fixture portal"
q "select count(*) as crm_events, (select count(*) from pgboss.job where name = 'triage') as triage_jobs from crm_event where portal_id = 900000001"

step "1. One event sent 3 times, attemptNumber 0, 1, 2 (HubSpot's retries)"
for n in 0 1 2; do run pnpm -s hs:replay packages/crm-hubspot/fixtures/contact-creation.json --attempt $n; done

step "2. A batch with retries inside it: creation again (attempt 1), lifecycle attempt 0 and 1, hs_lead_status"
run pnpm -s hs:replay docs/evidence/phase-3/batch-retry-inside.json

step "3. The mixed fixture batch (its lifecycle event is a retry of step 2's), then all of it again as attempt 1"
run pnpm -s hs:replay packages/crm-hubspot/fixtures/batch-mixed.json
run pnpm -s hs:replay packages/crm-hubspot/fixtures/batch-mixed.json --attempt 1

step "4. Signature v3 still holds: tampered body, old timestamp, URL-encoded query string"
run pnpm -s hs:replay packages/crm-hubspot/fixtures/contact-lifecyclestage-change.json --tamper --expect 401
run pnpm -s hs:replay packages/crm-hubspot/fixtures/contact-creation.json --age 301 --expect 401
run pnpm -s hs:replay packages/crm-hubspot/fixtures/contact-creation.json --url 'http://localhost:3100/api/webhooks/hubspot?env=dev&next=https%3A%2F%2Fapp.example.test%2Fdone%3Fa%3D1&tags=a%2Cb'

step "5. What the database holds: one row per distinct event, the first attempt kept"
q "select id, subscription_type, property_name, object_id, attempt_number, lead_id from crm_event where portal_id = 900000001 order by id"
step "6. And one triage job, for the one contact creation, with its ID derived from the dedupe key"
q "select j.id, j.state, j.data->>'crmEventId' as crm_event_id, j.data->>'contactId' as contact_id, left(j.data->>'dedupeKey', 12) || '…' as dedupe_key from pgboss.job j where j.name = 'triage' and j.data->>'portalId' = '900000001'"
