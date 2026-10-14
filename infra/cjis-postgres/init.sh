#!/bin/sh
# First-start init for the CJIS enclave database (SEC-12, ADR-0021, ADR-0037):
# a separate instance, roles and volume from the platform's. Holds no real CJI
# on a laptop (SCL-12).
# - cjis_migrator owns the `cjis` database and schema (DDL);
# - cjis_app serves API requests (DML only, row security per agency);
# - cjis_job runs the enclave worker's system jobs and provisioning;
# - cjis_idp owns the enclave Keycloak's own database.
# Extensions need a superuser, so they are created here. Passwords come from
# the environment (.env), never from this file (SCL-11).
set -eu
: "${CJIS_MIGRATOR_PASSWORD:?}" "${CJIS_APP_PASSWORD:?}" "${CJIS_JOB_PASSWORD:?}" "${CJIS_IDP_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_pw="$CJIS_MIGRATOR_PASSWORD" -v app_pw="$CJIS_APP_PASSWORD" \
  -v job_pw="$CJIS_JOB_PASSWORD" -v idp_pw="$CJIS_IDP_DB_PASSWORD" <<'SQL'
CREATE ROLE cjis_migrator LOGIN PASSWORD :'migrator_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE cjis_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE cjis_job LOGIN PASSWORD :'job_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE cjis OWNER cjis_migrator;
REVOKE ALL ON DATABASE cjis FROM PUBLIC;
GRANT CONNECT ON DATABASE cjis TO cjis_app, cjis_job;

CREATE ROLE cjis_idp LOGIN PASSWORD :'idp_pw';
CREATE DATABASE cjis_idp OWNER cjis_idp;
REVOKE ALL ON DATABASE cjis_idp FROM PUBLIC;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname cjis <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE, USAGE ON SCHEMA public TO cjis_migrator;
GRANT USAGE ON SCHEMA public TO cjis_app, cjis_job;
SQL
