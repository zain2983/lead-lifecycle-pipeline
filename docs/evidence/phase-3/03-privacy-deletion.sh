#!/bin/zsh
export HUBSPOT_CLIENT_SECRET=synthetic-offline-secret-phase3
q() { echo "\$ psql -c \"$1\""; docker exec llp-postgres-1 psql -U app -d phase3 -c "$1"; }
run() { echo "\$ $*"; "$@" 2>&1 | grep -v '^\$ \|^> \|^$'; echo "exit $pipestatus[1]"; }
lead="select source, email is null as email_null, first_name is null as first_null, last_name is null as last_null, company_name is null as company_null, job_title is null as title_null, message is null as message_null, pii_purged_at is not null as purged, hubspot_contact_id from lead where hubspot_portal_id = 900000001"
echo "commit $(git rev-parse --short HEAD), $(date -u +%FT%TZ), after 02-offline-worker-run.txt made the Lead"
echo; echo "=== 7. The Lead before (true = column is null)"; q "$lead"
echo; echo "=== 8. contact.privacyDeletion for that contact, then HubSpot's retry of it"
run pnpm -s hs:replay docs/evidence/phase-3/privacy-deletion.json
run pnpm -s hs:replay docs/evidence/phase-3/privacy-deletion.json --attempt 1
echo; echo "=== 9. The row stays, every PII column is null, and the deletion event points at it"; q "$lead"
q "select id, subscription_type, attempt_number, lead_id is not null as linked from crm_event where portal_id = 900000001 and object_id = 610000000001 order by id"
