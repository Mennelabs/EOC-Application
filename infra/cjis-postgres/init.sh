#!/bin/sh
# First-start init for the CJIS enclave database (SEC-12): separate instance,
# separate roles, separate volume. Holds no real CJI on a laptop (SCL-12).
set -eu
: "${CJIS_APP_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v app_pw="$CJIS_APP_PASSWORD" <<'SQL'
CREATE ROLE cjis_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE cjis OWNER postgres;
REVOKE ALL ON DATABASE cjis FROM PUBLIC;
GRANT CONNECT ON DATABASE cjis TO cjis_app;
SQL
