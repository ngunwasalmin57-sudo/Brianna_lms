#!/bin/sh
set -eu

: "${DB_PASSWORD:?DB_PASSWORD is required}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_password="$DB_PASSWORD" <<'SQL'
CREATE ROLE bml_app LOGIN PASSWORD :'app_password';
ALTER DATABASE bml_lms OWNER TO bml_app;
GRANT ALL ON SCHEMA public TO bml_app;
SQL
