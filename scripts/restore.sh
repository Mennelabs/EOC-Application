#!/bin/sh
# Restore a backup made by scripts/backup.sh into the local stack (NFR-05).
# Replaces the platform schema and the object store contents. Services are
# stopped during the restore and started again afterwards.
#
#   scripts/restore.sh backups/<timestamp>
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
SRC=${1:?backup directory}
DC="docker compose"
for f in $(echo "${COMPOSE_FILES:-compose.yaml}" | tr ',' ' '); do DC="$DC -f $f"; done
PROJECT=$($DC config --format json | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["name"])')

echo "stopping application services"
$DC stop api worker gateway >/dev/null

echo "restoring database from $SRC/cg.dump"
# Schema cg is dropped and recreated from the dump; extensions and roles are
# left as the init script made them. Ownership is restored to cg_migrator.
$DC exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db psql -h 127.0.0.1 -U postgres -d cg -v ON_ERROR_STOP=1 \
  -c "drop schema if exists cg cascade" -c "drop table if exists public.kysely_migration, public.kysely_migration_lock" >/dev/null
# Extensions (and their comments) belong to the superuser and are created by
# infra/postgres/init.sh; everything else in the dump is restored as cg_migrator.
DB_CONTAINER=$($DC ps -q db)
docker cp "$SRC/cg.dump" "$DB_CONTAINER:/tmp/cg.dump"
$DC exec -T db pg_restore -l /tmp/cg.dump | grep -vE ' (COMMENT - )?EXTENSION ' > "$SRC/restore.list"
docker cp "$SRC/restore.list" "$DB_CONTAINER:/tmp/restore.list"
$DC exec -T -e PGPASSWORD="$POSTGRES_PASSWORD" db pg_restore -h 127.0.0.1 -U postgres -d cg --no-owner --role=cg_migrator --exit-on-error -L /tmp/restore.list /tmp/cg.dump

echo "restoring object store volume from $SRC/objects.tgz"
$DC stop objects >/dev/null
docker run --rm -v "${PROJECT}_objects_data:/vol" -v "$(pwd)/$SRC:/in:ro" node:24-alpine \
  sh -c 'find /vol -mindepth 1 -delete && tar xzf /in/objects.tgz -C /vol'
$DC start objects >/dev/null

echo "starting application services"
$DC start api worker gateway >/dev/null
echo "restored; verify with tests/drills/restore-drill.sh or GET /api/v1/audit/verify"
