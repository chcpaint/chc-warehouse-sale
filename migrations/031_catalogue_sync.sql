-- ============================================================================
-- 031_catalogue_sync.sql
--
-- Two things: a customer who is never written to at all, and the ledger for
-- bringing everybody else's catalogue into line with the master.
--
-- 1. A THIRD CATALOGUE MODE
--
--    030 gave us open and closed. Closed means "no new items", which is not
--    the same as "leave this customer alone" — a closed catalogue would still
--    have its item names and barcodes rewritten by a sync, and for Assured
--    that is not wanted either.
--
--      open    receives new items, and is kept in step with the master
--      closed  is kept in step, but receives nothing new
--      frozen  is never written to by any bulk operation, at all
--
--    Assured is CLOSED, not frozen: their existing items are brought into
--    line with the master like everyone else's, and nothing new is ever
--    added to their list. Nobody is frozen today — the mode exists because
--    "leave this customer entirely alone" is a real requirement that would
--    otherwise be answered with a code change instead of a row.
--
-- 2. THE SYNC LEDGER
--
--    Rewriting a name, part number or barcode across every customer is not
--    reversible unless every old value was kept. One row per field changed,
--    the same rule the master import follows.
--
-- Safe to run more than once. No temp tables, no transaction control.
-- Checked with qa/migrations-smoke.sh.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. The third mode
-- ------------------------------------------------------------
alter table public.company_catalogue_policy
    drop constraint if exists company_catalogue_policy_mode_chk;

alter table public.company_catalogue_policy
    add constraint company_catalogue_policy_mode_chk
    check (push_mode in ('open', 'closed', 'frozen'));

comment on column public.company_catalogue_policy.push_mode is
    'open: receives new items and is kept in step with the master. closed: kept in step, receives nothing new. frozen: never written to by any bulk operation.';

-- No customer is frozen today. Assured stays CLOSED — set by 030 — which
-- means their existing items ARE kept in step with the master, and nothing
-- new is ever added to their list. The two are different questions and this
-- is the answer to each of them.
--
-- 'frozen' exists for the case where a customer's catalogue must not be
-- written to at all. Nobody is in that state; if one ever is, it is one row
-- in company_catalogue_policy, not a code change.

-- The entitlement view gains nothing new, but its rule changed: frozen is not
-- entitled to anything at all, where closed was entitled to what it already
-- held. Dropped and rebuilt rather than replaced, for the reason 029 explains.
drop view if exists public.v_company_catalogue_entitlement;

create view public.v_company_catalogue_entitlement
with (security_invoker = true) as
select
    c.id                as company_id,
    c.name              as company_name,
    l.id                as item_id,
    l.sku,
    l.sku_key,
    l.name              as item_name,
    l.brand,
    l.category,
    l.barcode,
    l.list_price,
    coalesce(pol.push_mode, 'open')                        as push_mode,
    (
        x.id is null
        and coalesce(pol.push_mode, 'open') <> 'frozen'
        and (
            coalesce(pol.push_mode, 'open') = 'open'
            or exists (
                select 1 from public.products p
                 where p.company_id = c.id
                   and upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g')) = l.sku_key
            )
        )
    )                                                       as entitled,
    coalesce(x.reason, case when coalesce(pol.push_mode, 'open') <> 'open'
                            then pol.reason end)            as excluded_reason
  from public.companies c
 cross join public.item_library l
  left join public.company_catalogue_exclusions x
         on x.company_id = c.id
        and (   (x.brand    is not null and lower(x.brand)    = lower(l.brand))
             or (x.category is not null and lower(x.category) = lower(l.category))
             or (x.sku_key  is not null and x.sku_key         = l.sku_key))
  left join public.company_catalogue_policy pol
         on pol.company_id = c.id
 where c.is_active
   and l.is_active;

comment on view public.v_company_catalogue_entitlement is
    'Every master item against every customer, with entitled=false and a reason where a brand rule, a closed catalogue or a frozen one says they must not receive it.';

-- ------------------------------------------------------------
-- 2. The sync ledger
-- ------------------------------------------------------------
create table if not exists public.catalogue_sync_runs (
    id             uuid primary key default gen_random_uuid(),
    scope          text not null default 'all',
    fields         text[] not null default '{}',
    companies_touched integer not null default 0,
    products_examined integer not null default 0,
    products_changed  integer not null default 0,
    field_changes     integer not null default 0,
    skipped_frozen    integer not null default 0,
    applied        boolean not null default false,
    run_by         uuid references public.admin_users(id) on delete set null,
    created_at     timestamptz not null default now(),
    notes          text
);

comment on table public.catalogue_sync_runs is
    'One row per catalogue sync, previewed or applied. skipped_frozen counts customers deliberately left alone.';

alter table public.catalogue_sync_runs enable row level security;
revoke all on public.catalogue_sync_runs from anon, authenticated;

create table if not exists public.catalogue_sync_changes (
    id          uuid primary key default gen_random_uuid(),
    run_id      uuid not null references public.catalogue_sync_runs(id) on delete cascade,
    company_id  uuid references public.companies(id) on delete set null,
    product_id  uuid references public.products(id) on delete set null,
    sku_key     text,
    field       text not null,
    old_value   text,
    new_value   text,
    reason      text,
    created_at  timestamptz not null default now()
);

comment on table public.catalogue_sync_changes is
    'Every name, part number and barcode a sync rewrote, with what it was before. A sync is only defensible because this exists.';

create index if not exists idx_catalogue_sync_changes_run
    on public.catalogue_sync_changes (run_id);
create index if not exists idx_catalogue_sync_changes_product
    on public.catalogue_sync_changes (product_id);

alter table public.catalogue_sync_changes enable row level security;
revoke all on public.catalogue_sync_changes from anon, authenticated;

-- ------------------------------------------------------------
-- 3. What a sync would change, without changing it.
--
-- One row per product whose name, part number or barcode differs from the
-- master item it resolves to. Frozen customers are absent entirely — not
-- listed as "would change but skipped", because they are not candidates.
-- ------------------------------------------------------------
create or replace view public.v_catalogue_drift
with (security_invoker = true) as
select
    p.id                                as product_id,
    p.company_id,
    c.name                              as company_name,
    p.sku                               as current_sku,
    p.name                              as current_name,
    l.sku                               as master_sku,
    l.name                              as master_name,
    l.barcode                           as master_barcode,
    b.barcode                           as current_barcode,
    (p.name is distinct from l.name)    as name_differs,
    (p.sku  is distinct from l.sku)     as sku_differs,
    (l.barcode is not null and l.barcode <> ''
     and b.barcode is distinct from l.barcode) as barcode_differs
  from public.products p
  join public.companies c on c.id = p.company_id
  join public.item_library l
    on l.sku_key = upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g'))
  left join public.company_catalogue_policy pol on pol.company_id = p.company_id
  left join public.product_barcodes b on b.product_id = p.id and b.is_primary
 where p.is_active
   and l.is_active
   and coalesce(pol.push_mode, 'open') <> 'frozen';

comment on view public.v_catalogue_drift is
    'Products whose name, part number or barcode does not match the master item they resolve to. Frozen customers are excluded — they are not candidates for a sync.';
