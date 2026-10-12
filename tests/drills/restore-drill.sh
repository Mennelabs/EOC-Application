#!/bin/sh
# Restore drill (NFR-05, GATE-09 recovery half): back up, destroy the schema,
# restore, and prove the audit chains verify with the same heads as before.
# Run against a seeded local stack. Destructive by design; synthetic data only.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
DC="docker compose"
for f in $(echo "${COMPOSE_FILES:-compose.yaml}" | tr ',' ' '); do DC="$DC -f $f"; done
psql() { $DC exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -h 127.0.0.1 -U postgres -d cg -tA -c "$1"; }

OUT=backups/drill-$(date -u +%Y%m%dT%H%M%SZ)
scripts/backup.sh "$OUT"
BEFORE=$(cat "$OUT/audit-heads.txt")
ROWS_BEFORE=$(psql "select count(*) from cg.audit_event")

echo "== destroying schema cg"
psql "drop schema cg cascade" >/dev/null
psql "select count(*) from information_schema.tables where table_schema='cg'" | grep -qx 0 && echo "schema gone"

scripts/restore.sh "$OUT"

echo "== verifying"
AFTER=$(psql "select tenant_id || ' ' || max(seq) || ' ' || encode((select hash from cg.audit_event e2 where e2.tenant_id = e.tenant_id order by seq desc limit 1), 'hex') from cg.audit_event e group by tenant_id order by 1")
ROWS_AFTER=$(psql "select count(*) from cg.audit_event")
[ "$BEFORE" = "$AFTER" ] && echo "audit heads identical ($ROWS_BEFORE -> $ROWS_AFTER rows)" || { echo "AUDIT HEADS DIFFER"; exit 1; }
for t in $(psql "select id from cg.tenant"); do
  psql "select ok from cg.audit_verify('$t')" | grep -qx t || { echo "chain broken for $t"; exit 1; }
done
echo "every tenant chain verifies after restore"
# Immutability survived the restore too (FR-08.04).
psql "update cg.audit_event set action='x' where seq=(select min(seq) from cg.audit_event)" 2>&1 | grep -q immutable && echo "immutability trigger present"
