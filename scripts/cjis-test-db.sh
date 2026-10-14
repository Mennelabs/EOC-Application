#!/bin/sh
# Throwaway CJIS enclave database for the enclave's database-backed tests
# (layer-5 plan §9). Started from the same init script as the compose
# `cjis-db`, but on its own: the compose enclave publishes no database port.
# Synthetic data only (SCL-12).
#
#   eval "$(scripts/cjis-test-db.sh)"     # start (or reuse), migrate, print env
#   scripts/cjis-test-db.sh --stop        # remove it
set -eu
cd "$(dirname "$0")/.."
NAME=cg-cjis-test-db
PORT=${CJIS_TEST_DB_PORT:-5433}
PW=cjis-test-only

if [ "${1:-}" = "--stop" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  exit 0
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_PASSWORD="$PW" -e CJIS_MIGRATOR_PASSWORD="$PW" -e CJIS_APP_PASSWORD="$PW" \
    -e CJIS_JOB_PASSWORD="$PW" -e CJIS_IDP_DB_PASSWORD="$PW" \
    -v "$PWD/infra/cjis-postgres/init.sh:/docker-entrypoint-initdb.d/10-init.sh:ro" \
    -p "127.0.0.1:$PORT:5432" postgis/postgis:16-3.4-alpine >/dev/null
  # The init script runs, then the server restarts; wait for the final one.
  i=0
  until docker exec "$NAME" psql -U cjis_migrator -d cjis -h 127.0.0.1 -c 'select 1' >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && { echo "enclave test database did not start" >&2; exit 1; }
    sleep 1
  done
fi

CJIS_DATABASE_MIGRATOR_URL="postgres://cjis_migrator:$PW@127.0.0.1:$PORT/cjis" \
  node packages/cjis-db/src/migrate.ts >&2

echo "export CJIS_DB_TEST_MIGRATOR_URL=postgres://cjis_migrator:$PW@127.0.0.1:$PORT/cjis"
echo "export CJIS_DB_TEST_APP_URL=postgres://cjis_app:$PW@127.0.0.1:$PORT/cjis"
echo "export CJIS_DB_TEST_JOB_URL=postgres://cjis_job:$PW@127.0.0.1:$PORT/cjis"
