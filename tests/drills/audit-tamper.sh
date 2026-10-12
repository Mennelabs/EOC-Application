#!/bin/sh
# Audit tamper drill (SEC-18, FR-08.04, ADR-0012). Proves, on a disposable
# stack, that: application roles cannot change audit rows; the superuser is
# refused by the trigger; and a change made with the trigger disabled is
# detected by cg.audit_verify with the first bad sequence number.
# DESTRUCTIVE: leaves one tampered row behind. Run only on a throwaway stack
# (docker compose down -v afterwards). Synthetic data only.
set -u
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
DC="docker compose"
for f in $(echo "${COMPOSE_FILES:-compose.yaml}" | tr ',' ' '); do DC="$DC -f $f"; done
run() { $DC exec -T -e PGPASSWORD="$2" db psql -h 127.0.0.1 -U "$1" -d cg -v ON_ERROR_STOP=0 -tA -c "$3"; }
T=$(run postgres "$POSTGRES_PASSWORD" "select tenant_id from cg.audit_event group by tenant_id order by count(*) desc limit 1")

echo "== chain before: $(run postgres "$POSTGRES_PASSWORD" "select 'ok=' || ok || ' checked=' || checked from cg.audit_verify('$T')")"
echo "== cg_app update/delete (expect: permission denied)"
run cg_app "$CG_APP_PASSWORD" "update cg.audit_event set action='x' where tenant_id='$T'"
run cg_worker "$CG_WORKER_PASSWORD" "delete from cg.audit_event where tenant_id='$T'"
echo "== superuser update/delete/truncate (expect: immutable)"
run postgres "$POSTGRES_PASSWORD" "update cg.audit_event set action='x' where seq=(select min(seq) from cg.audit_event where tenant_id='$T')"
run postgres "$POSTGRES_PASSWORD" "delete from cg.audit_event where seq=(select min(seq) from cg.audit_event where tenant_id='$T')"
run postgres "$POSTGRES_PASSWORD" "truncate cg.audit_event"
echo "== tamper with trigger disabled (expect: ok=false, first_bad_seq set)"
run postgres "$POSTGRES_PASSWORD" "alter table cg.audit_event disable trigger audit_no_update; update cg.audit_event set action='tampered' where seq=(select seq from cg.audit_event where tenant_id='$T' order by seq offset 1 limit 1); alter table cg.audit_event enable trigger audit_no_update"
run postgres "$POSTGRES_PASSWORD" "select 'after tamper: ok=' || ok || ' checked=' || checked || ' first_bad_seq=' || coalesce(first_bad_seq::text,'none') from cg.audit_verify('$T')"
