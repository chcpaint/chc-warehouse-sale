#!/usr/bin/env bash
# scripts/backup/dump-db.sh -- logical backup of the app's database.
#
#   SUPABASE_DB_URL=postgres://... OUT_DIR=./out scripts/backup/dump-db.sh
#
# Writes to OUT_DIR:
#   db.dump        pg_dump custom format of the public schema (all app tables,
#                  views, functions, triggers, policies, data)
#   manifest.json  exact row count of every table, for the restore drill
#
# Read-only on the database: pg_dump and SELECT count(*) only.
#
# PG_DUMP / PSQL can be overridden to run a matching client version, e.g.
#   PG_DUMP="docker run --rm --network host -v $PWD:/w -w /w postgres:17 pg_dump"
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL (Supabase > Connect > Session pooler connection string)}"
OUT_DIR="${OUT_DIR:-./backup-out}"
PG_DUMP="${PG_DUMP:-pg_dump}"
PSQL="${PSQL:-psql}"
mkdir -p "$OUT_DIR"

echo "Dumping the public schema..."
# --no-owner / --no-privileges: restorable into any fresh Postgres, not just Supabase.
# The pre-data/data/post-data order of a custom-format dump loads rows before
# triggers exist, so append-only and stock-applying triggers do not re-fire.
$PG_DUMP "$SUPABASE_DB_URL" --format=custom --compress=9 --no-owner --no-privileges \
  --schema=public --file="$OUT_DIR/db.dump"

echo "Counting rows..."
$PSQL "$SUPABASE_DB_URL" -X -A -t -v ON_ERROR_STOP=1 -c "
  select json_build_object(
    'generated_at', now(),
    'server_version', current_setting('server_version'),
    'tables', coalesce(json_object_agg(t.table_name, t.n), '{}'::json)
  )
  from (
    select table_name,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint as n
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  ) t;" > "$OUT_DIR/manifest.json"

bytes=$(wc -c < "$OUT_DIR/db.dump")
tables=$(node -e "const m=require(require('path').resolve(process.argv[1]));console.log(Object.keys(m.tables).length)" "$OUT_DIR/manifest.json")
echo "Database dump: $bytes bytes, $tables tables."
