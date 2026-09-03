#!/bin/bash
#
# qa/migrations-smoke.sh — run migrations against a real Postgres before they
# reach anybody's database.
#
#   bash qa/migrations-smoke.sh            # the migrations listed below
#   bash qa/migrations-smoke.sh 029 030    # just these
#
# WHY THIS EXISTS
# ---------------
# Two migrations shipped with defects that only surfaced when they were pasted
# into the production SQL editor:
#
#   026  used a temp table with ON COMMIT DROP. Correct in psql, wrong over a
#        pooled autocommit connection, where the table vanished before the next
#        statement.
#   030  changed a view's column ORDER with CREATE OR REPLACE VIEW, which
#        Postgres refuses — it can only append columns.
#
# Both are things a human reading the SQL will miss and a database catches in
# under a second. Neither was caught because the SQL was never executed
# anywhere before production.
#
# WHAT IT CHECKS
#   1. the migration runs at all, on a clean database
#   2. it runs AGAIN without error — every migration here must be re-runnable,
#      because the recovery procedure for a half-applied migration is to fix it
#      and run the whole file again
#   3. it contains nothing that a pooled autocommit connection would break
#
# It builds a minimal stand-in for the tables these migrations depend on rather
# than replaying the whole schema history. That is a real limitation: it proves
# the SQL is valid and re-runnable, not that it is correct against production
# data.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MIGRATIONS=("${@:-}")
if [ -z "${MIGRATIONS[0]:-}" ]; then MIGRATIONS=(029 030); fi

PGPORT="${PGPORT:-5599}"
PGDATA="${PGDATA:-/tmp/pg-smoke}"
SOCK=/tmp
PSQL="psql -h $SOCK -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"
FAIL=0

green(){ printf '    \033[0;32mPASS\033[0m  %s\n' "$1"; }
red(){   printf '    \033[0;31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
say(){   printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }

# Absolute paths, because `su postgres -c` starts a fresh login shell and
# throws away anything added to PATH here.
PGBIN="$(dirname "$(command -v initdb 2>/dev/null || true)")"
[ -x "$PGBIN/initdb" ] || PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
[ -x "$PGBIN/initdb" ] || { echo "Postgres is not installed — install postgresql and re-run."; exit 2; }

say "Starting a throwaway Postgres on port $PGPORT"
"$PGBIN/pg_ctl" -D "$PGDATA" stop >/dev/null 2>&1 || true
rm -rf "$PGDATA"; mkdir -p "$PGDATA"
if id postgres >/dev/null 2>&1 && [ "$(id -u)" = "0" ]; then
    chown -R postgres:postgres "$PGDATA"
    AS="su postgres -c"
else
    AS="bash -c"
fi
$AS "$PGBIN/initdb -D $PGDATA -A trust" >/tmp/pg-smoke-init.log 2>&1 || { tail -5 /tmp/pg-smoke-init.log; exit 1; }
$AS "$PGBIN/pg_ctl -D $PGDATA -o '-p $PGPORT -k $SOCK' -l /tmp/pg-smoke.log start" >/dev/null 2>&1
for i in $(seq 20); do $PSQL -c 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
$PSQL -c 'select 1' >/dev/null 2>&1 || { echo "Postgres would not start:"; tail -10 /tmp/pg-smoke.log; exit 1; }
trap '$AS "$PGBIN/pg_ctl -D $PGDATA stop" >/dev/null 2>&1' EXIT

# Supabase's built-in roles, which the migrations REVOKE from.
$PSQL -c "create role anon;"          >/dev/null 2>&1
$PSQL -c "create role authenticated;" >/dev/null 2>&1
$PSQL -c "create role service_role;"  >/dev/null 2>&1

# ------------------------------------------------------------------
# A stand-in for the tables these migrations build on. Column names and
# types match production; anything a migration references that is missing
# here fails loudly, which is the point.
# ------------------------------------------------------------------
cat > /tmp/smoke-base.sql <<'SQL'
create table admin_users (
    id uuid primary key default gen_random_uuid(), email text, name text, role text);
create table companies (
    id uuid primary key default gen_random_uuid(), name text not null, slug text,
    is_active boolean not null default true, settings jsonb,
    created_at timestamptz not null default now());
create table company_locations (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    name text, is_active boolean not null default true);
create table products (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    sku text, name text, brand text, category text, price numeric,
    price_on_request boolean not null default false, case_qty numeric, unit text,
    is_active boolean not null default true);
create table product_barcodes (
    id uuid primary key default gen_random_uuid(),
    product_id uuid not null references products(id) on delete cascade,
    barcode text, symbology text, is_primary boolean, source text, is_internal boolean);
create table item_library (
    id uuid primary key default gen_random_uuid(), sku text not null, sku_key text not null,
    name text not null, brand text, vendor_code text, barcode text, unit text, case_qty numeric,
    list_price numeric, source text not null default 'master_import', source_ref text,
    imported_at timestamptz not null default now(), notes text,
    constraint item_library_sku_key_unique unique (sku_key));
create table orders (
    id uuid primary key default gen_random_uuid(),
    company_id uuid references companies(id) on delete cascade,
    status text, total numeric, items jsonb, created_at timestamptz not null default now());
create table stock_movements (
    id uuid primary key default gen_random_uuid(),
    company_id uuid references companies(id) on delete cascade,
    location_id uuid references company_locations(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    qty_change numeric, movement_type text, job_ref text,
    source_doc_type text, source_doc_id uuid, created_at timestamptz not null default now());
create table kit_consumptions (
    id uuid primary key default gen_random_uuid(),
    company_id uuid references companies(id) on delete cascade,
    kit_name text, job_ref text, total_cost numeric, created_at timestamptz not null default now());
-- repair_kits / kit_items / company_kit_access predate every migration here
-- (loaded once from a Skyline export, per 016's own comment) — stood in for
-- the same reason companies and admin_users are, so a migration that builds
-- on them can be smoke-tested too.
create table repair_kits (
    id uuid primary key default gen_random_uuid(),
    company_id uuid references companies(id) on delete cascade,
    name text not null, description text, source text, sort_order integer not null default 0,
    is_active boolean not null default true, updated_at timestamptz not null default now());
create table kit_items (
    id uuid primary key default gen_random_uuid(),
    kit_id uuid not null references repair_kits(id) on delete cascade,
    sku text, product_id uuid references products(id) on delete set null,
    quantity numeric not null default 1, unit text, sort_order integer not null default 0,
    needs_review boolean not null default false);
create table company_kit_access (
    company_id uuid not null references companies(id) on delete cascade,
    kit_id uuid not null references repair_kits(id) on delete cascade,
    enabled boolean not null default false,
    primary key (company_id, kit_id));
create table kit_product_map (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    kit_item_id uuid not null references kit_items(id) on delete cascade,
    product_id uuid references products(id) on delete cascade,
    quantity numeric, is_excluded boolean not null default false, note text,
    updated_at timestamptz not null default now(), updated_by uuid references admin_users(id) on delete set null,
    constraint kit_product_map_unique unique (company_id, kit_item_id));

-- Two customers, so the migrations that seed a rule by name have something to
-- find. "Assured" is deliberately present: a migration that silently seeds
-- nothing would otherwise pass this smoke test.
insert into companies (name, slug) values ('Assured Collision','assured'), ('Bayview Auto Body','bayview');
SQL

overall_start=1
for m in "${MIGRATIONS[@]}"; do
    file=$(ls migrations/${m}_*.sql 2>/dev/null | head -1)
    [ -n "$file" ] || { red "no migration matching '${m}_*'"; continue; }
    say "$(basename "$file")"

    # ---- static check: things a pooled autocommit connection breaks ----
    if grep -qiE 'create[[:space:]]+(global[[:space:]]+|local[[:space:]]+)?temp(orary)?[[:space:]]+table' "$file"; then
        red "uses a temp table — it will not survive the Supabase SQL editor's pooled connection"
    else
        green "no temp tables"
    fi
    if grep -qiE '^[[:space:]]*(begin|commit|rollback)[[:space:]]*;' "$file"; then
        red "uses transaction control — each statement is autocommitted separately in the SQL editor"
    else
        green "no transaction control"
    fi

    # ---- it runs, on a clean database ----
    $PSQL -c "drop database if exists smoke;" >/dev/null 2>&1
    $PSQL -c "create database smoke;" >/dev/null
    $PSQL -d smoke -f /tmp/smoke-base.sql >/dev/null 2>&1

    # Everything before this one, so a migration is tested on the state it will
    # really meet rather than on an empty database.
    for prev in "${MIGRATIONS[@]}"; do
        [ "$prev" = "$m" ] && break
        p=$(ls migrations/${prev}_*.sql 2>/dev/null | head -1)
        [ -n "$p" ] && $PSQL -d smoke -f "$p" >/dev/null 2>&1
    done

    if $PSQL -d smoke -f "$file" >/tmp/smoke-run.log 2>&1; then
        green "runs on a clean database"
    else
        red "does not run:"
        grep -i 'error' /tmp/smoke-run.log | head -3 | sed 's/^/          /'
    fi

    # ---- and runs again ----
    if $PSQL -d smoke -f "$file" >/tmp/smoke-again.log 2>&1; then
        green "runs a second time (re-runnable)"
    else
        red "fails on a second run — a half-applied migration could not be recovered by re-running it:"
        grep -i 'error' /tmp/smoke-again.log | head -3 | sed 's/^/          /'
    fi
done

say "Result"
if [ "$FAIL" -eq 0 ]; then
    printf '    \033[0;32mAll checks passed.\033[0m\n\n'
else
    printf '    \033[0;31m%s check(s) failed.\033[0m Do not ship these.\n\n' "$FAIL"
fi
exit $((FAIL > 0))
