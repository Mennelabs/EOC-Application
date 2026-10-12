#!/bin/sh
# First-start init for the platform database (runs once, as the superuser).
# - cg_migrator owns the `cg` database and schema (DDL); cg_app has DML only
#   (ADR-0005). Extensions need a superuser, so they are created here.
# - Keycloak gets its own database and role (ADR-0008).
# Passwords come from the environment (.env), never from this file (SCL-11).
set -eu
: "${CG_MIGRATOR_PASSWORD:?}" "${CG_APP_PASSWORD:?}" "${KEYCLOAK_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v migrator_pw="$CG_MIGRATOR_PASSWORD" -v app_pw="$CG_APP_PASSWORD" -v kc_pw="$KEYCLOAK_DB_PASSWORD" <<'SQL'
CREATE ROLE cg_migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE cg_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE cg OWNER cg_migrator;
REVOKE ALL ON DATABASE cg FROM PUBLIC;
GRANT CONNECT ON DATABASE cg TO cg_app;

CREATE ROLE keycloak LOGIN PASSWORD :'kc_pw';
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname cg <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CREATE, USAGE ON SCHEMA public TO cg_migrator;
SQL
