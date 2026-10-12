#!/bin/sh
# Backup of the local stack (NFR-05, GATE-09 recovery half): PostgreSQL
# custom-format dump of the platform database plus a tarball of the object
# store volume. Output: backups/<timestamp>/. Synthetic data only (SCL-12).
#
#   scripts/backup.sh [out-dir]
# Set COMPOSE_FILES=compose.yaml,other.yaml to use extra compose files.
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=${1:-backups/$STAMP}
mkdir -p "$OUT"
DC="docker compose"
for f in $(echo "${COMPOSE_FILES:-compose.yaml}" | tr ',' ' '); do DC="$DC -f $f"; done
PROJECT=$($DC config --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["name"])')

# spatial_ref_sys is PostGIS extension data, recreated by CREATE EXTENSION; not ours to restore.
echo "backing up database -> $OUT/cg.dump"
$DC exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db pg_dump -h 127.0.0.1 -U postgres -d cg -Fc --exclude-table-data=public.spatial_ref_sys > "$OUT/cg.dump"

echo "backing up object store volume -> $OUT/objects.tgz"
docker run --rm -v "${PROJECT}_objects_data:/vol:ro" -v "$(pwd)/$OUT:/out" node:24-alpine \
  tar czf /out/objects.tgz -C /vol .

# Audit chain heads at backup time, so a restore can prove it brought back
# exactly what was saved (SEC-18).
$DC exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -h 127.0.0.1 -U postgres -d cg -tA \
  -c "select tenant_id || ' ' || max(seq) || ' ' || encode((select hash from cg.audit_event e2 where e2.tenant_id = e.tenant_id order by seq desc limit 1), 'hex') from cg.audit_event e group by tenant_id order by 1" \
  > "$OUT/audit-heads.txt"
echo "database: $(stat -c %s "$OUT/cg.dump") bytes; objects: $(stat -c %s "$OUT/objects.tgz") bytes; tenants with audit: $(wc -l < "$OUT/audit-heads.txt")"
