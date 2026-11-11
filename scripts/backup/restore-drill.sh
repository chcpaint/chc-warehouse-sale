#!/usr/bin/env bash
# scripts/backup/restore-drill.sh -- prove a backup restores.
#
#   BACKUP_FILE=chc-backup-2026-11-12.tar.gz.gpg BACKUP_PASSPHRASE=... \
#   TARGET_DB_URL=postgres://postgres:postgres@localhost:5432/drill \
#   scripts/backup/restore-drill.sh
#
# Decrypts the backup, restores the database into TARGET_DB_URL (an EMPTY,
# throwaway database -- never production), then checks every table has exactly
# the rows the manifest says it had when the backup was taken, and that every
# stored file is present. Exits non-zero on any difference, so a scheduled run
# that fails is a backup that would not have restored.
#
# PG_RESTORE / PSQL can be overridden to use a matching client version.
set -euo pipefail

: "${BACKUP_FILE:?Set BACKUP_FILE}"
: "${BACKUP_PASSPHRASE:?Set BACKUP_PASSPHRASE}"
: "${TARGET_DB_URL:?Set TARGET_DB_URL to an empty scratch database}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"
WORK="${WORK_DIR:-$(mktemp -d)}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

case "$TARGET_DB_URL" in
  *supabase.co*|*supabase.com*|*pooler.supabase*) echo "Refusing: the drill restores into a scratch database, not Supabase." >&2; exit 2;;
esac

echo "Decrypting..."
printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --yes --pinentry-mode loopback --passphrase-fd 0 \
  --decrypt --output "$WORK/backup.tar.gz" "$BACKUP_FILE"
tar -xzf "$WORK/backup.tar.gz" -C "$WORK"
test -f "$WORK/db.dump" && test -f "$WORK/manifest.json" || { echo "Backup is missing db.dump or manifest.json" >&2; exit 1; }

echo "Preparing the scratch database..."
# What a Supabase database provides that a plain Postgres does not: the roles
# policies may name, and the extensions schema the app's functions use.
$PSQL "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
SQL

echo "Restoring..."
# --clean --if-exists replaces the empty public schema the scratch database
# starts with. Any error fails the drill.
$PG_RESTORE --dbname="$TARGET_DB_URL" --no-owner --no-privileges --clean --if-exists --exit-on-error "$WORK/db.dump"

echo "Comparing row counts with the manifest..."
$PSQL "$TARGET_DB_URL" -X -A -t -v ON_ERROR_STOP=1 -c "
  select coalesce(json_object_agg(t.table_name, t.n), '{}'::json)
  from (
    select table_name,
           (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text::bigint as n
      from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  ) t;" > "$WORK/restored.json"

node - "$WORK/manifest.json" "$WORK/restored.json" "$WORK" "$SUMMARY" <<'NODE'
const fs = require('fs');
const path = require('path');
const [manifestPath, restoredPath, work, summaryPath] = process.argv.slice(2);
const want = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const got = JSON.parse(fs.readFileSync(restoredPath, 'utf8'));
const problems = [];
let rows = 0;
for (const [t, n] of Object.entries(want.tables)) {
  rows += Number(n);
  if (!(t in got)) problems.push(`table ${t} missing after restore`);
  else if (Number(got[t]) !== Number(n)) problems.push(`table ${t}: backup had ${n} rows, restore has ${got[t]}`);
}
let files = 0, fileProblems = 0;
const sm = path.join(work, 'storage-manifest.json');
if (fs.existsSync(sm)) {
  const s = JSON.parse(fs.readFileSync(sm, 'utf8'));
  const count = d => !fs.existsSync(d) ? 0 : fs.readdirSync(d, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
  for (const [b, info] of Object.entries(s.buckets)) {
    const have = count(path.join(work, 'storage', b));
    files += have;
    if (have !== info.files) { fileProblems++; problems.push(`bucket ${b}: backup listed ${info.files} files, archive has ${have}`); }
  }
}
const ok = problems.length === 0;
const lines = [
  `## Restore drill: ${ok ? 'PASSED' : 'FAILED'}`,
  '',
  `Backup taken ${want.generated_at} (Postgres ${want.server_version}).`,
  `${Object.keys(want.tables).length} tables and ${rows} rows restored and counted; ${files} stored files present.`,
  ...(ok ? [] : ['', '**Problems:**', ...problems.map(p => `- ${p}`)])
];
fs.appendFileSync(summaryPath, lines.join('\n') + '\n');
const bytes = fs.statSync(path.join(work, 'db.dump')).size;
if (process.env.DRILL_RESULT) fs.writeFileSync(process.env.DRILL_RESULT, JSON.stringify({
  status: ok ? 'passed' : 'failed', tables: Object.keys(want.tables).length, rows_checked: rows, files, bytes,
  note: ok ? null : problems.slice(0, 5).join('; ').slice(0, 500)
}));
if (!ok) process.exit(1);
NODE
echo "Restore drill passed."
