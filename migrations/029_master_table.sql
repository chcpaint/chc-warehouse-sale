-- ============================================================================
-- 029_master_table.sql
--
-- Turns the Item Library into a maintainable master table.
--
-- What was missing was not the table — item_library has held the canonical
-- SKU, name, brand and barcode since 021. What was missing was any way to
-- LOAD it. It was populated once by hand and nothing in the console could
-- refresh it, so a corrected master file had nowhere to go.
--
-- This adds four things:
--
--   1. The columns the master file actually carries (category, sub-category)
--      and a barcode_level, because the file mixes each-level and case-level
--      codes and a scanner cannot tell them apart on its own.
--
--   2. An import ledger and a per-field change log. Loads are "file wins",
--      which is only safe if every value the file overwrote is recoverable.
--      Nothing is overwritten without a row here saying what it was.
--
--   3. company_item_aliases — the crossover table. A shop that calls a part
--      something else gets an alias row pointing at the master item, so
--      reporting can group the same part across every customer under one
--      name without anyone being made to rename their catalogue.
--
--   4. Views that resolve a shop product to its master item, so reporting
--      has one place to ask "what part is this, really?".
--
-- Safe to run more than once. No temp tables and no transaction control, so
-- it survives the Supabase SQL editor's pooled autocommit connection.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. Columns the master file carries that the library did not hold
-- ------------------------------------------------------------
alter table public.item_library add column if not exists category      text;
alter table public.item_library add column if not exists sub_category  text;
alter table public.item_library add column if not exists is_active     boolean not null default true;
alter table public.item_library add column if not exists updated_at    timestamptz not null default now();

-- Which unit the barcode identifies. The August file mixes them: eleven codes
-- are 14 digits (GTIN-14, a case) and eleven more appear on two parts each,
-- usually an "each" and its "- ROLL" sibling. Scanning a case code expecting
-- one item puts the count out by the case quantity, so the level is recorded
-- rather than assumed.
alter table public.item_library add column if not exists barcode_level text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'item_library_barcode_level_chk') then
        alter table public.item_library
            add constraint item_library_barcode_level_chk
            check (barcode_level is null or barcode_level in ('each','case','unknown'));
    end if;
end $$;

comment on column public.item_library.barcode_level is
    'Whether barcode identifies a single item (each) or a carton (case). A 14-digit GTIN is a case code; scanning it as an each understates consumption by the case quantity.';
comment on column public.item_library.is_active is
    'False retires a part from the pick-lists without deleting it. History that already references it stays intact.';

create index if not exists idx_item_library_category
    on public.item_library (category) where category is not null;

-- ------------------------------------------------------------
-- 2. Import ledger — one row per load
-- ------------------------------------------------------------
create table if not exists public.item_library_imports (
    id             uuid primary key default gen_random_uuid(),
    filename       text,
    sheet_name     text,
    source_label   text not null default 'master_import',
    rows_in_file   integer not null default 0,
    created_count  integer not null default 0,
    updated_count  integer not null default 0,
    unchanged_count integer not null default 0,
    skipped_count  integer not null default 0,
    field_changes  integer not null default 0,
    -- A load that was previewed but not applied is still worth recording:
    -- it is the evidence for what was decided and when.
    applied        boolean not null default false,
    imported_by    uuid references public.admin_users(id) on delete set null,
    created_at     timestamptz not null default now(),
    notes          text
);

comment on table public.item_library_imports is
    'One row per master-file load, applied or previewed. The batch a change log row belongs to.';

alter table public.item_library_imports enable row level security;
revoke all on public.item_library_imports from anon, authenticated;

-- ------------------------------------------------------------
-- 3. Per-field change log
--
-- "File wins" is only a defensible rule if every overwrite can be seen and
-- reversed. One row per field actually changed — not per row touched, so a
-- load that changes nothing writes nothing.
-- ------------------------------------------------------------
create table if not exists public.item_library_changes (
    id          uuid primary key default gen_random_uuid(),
    import_id   uuid not null references public.item_library_imports(id) on delete cascade,
    item_id     uuid references public.item_library(id) on delete set null,
    sku_key     text not null,
    sku         text,
    action      text not null,
    field       text,
    old_value   text,
    new_value   text,
    reason      text,
    created_at  timestamptz not null default now(),
    constraint item_library_changes_action_chk
        check (action in ('created','updated','skipped','conflict'))
);

comment on table public.item_library_changes is
    'What each import did, field by field. old_value is what was there before, so any overwrite can be reversed by hand.';
comment on column public.item_library_changes.reason is
    'Why a row was skipped or flagged: a part number that collides with another once punctuation is stripped, a barcode already used by a different part, a missing name.';

create index if not exists idx_item_library_changes_import
    on public.item_library_changes (import_id);
create index if not exists idx_item_library_changes_sku
    on public.item_library_changes (sku_key);

alter table public.item_library_changes enable row level security;
revoke all on public.item_library_changes from anon, authenticated;

-- ------------------------------------------------------------
-- 4. The crossover table
--
-- A shop calls 3M 06652 "yellow tape 3/4". That is their business and they
-- are not going to stop. An alias maps their spelling to the master part so
-- cross-shop reporting can group it correctly, WITHOUT changing anything in
-- their catalogue.
--
-- approved_by_company matters: an alias CHC guessed is a proposal until the
-- shop confirms it. Reporting can choose to use only approved ones, so a bad
-- guess never quietly merges two different parts in a customer's numbers.
-- ------------------------------------------------------------
create table if not exists public.company_item_aliases (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references public.companies(id) on delete cascade,

    -- What the shop calls it. Either may be null: some shops differ only in
    -- the name, some only in the part number.
    alias_sku        text,
    alias_sku_key    text,
    alias_name       text,

    -- What it really is.
    library_sku_key  text not null,

    -- Optional hard link to the row in that shop's catalogue, when the alias
    -- was created from a specific product rather than from a list.
    product_id       uuid references public.products(id) on delete set null,

    approved         boolean not null default false,
    approved_at      timestamptz,
    approved_by      text,

    source           text not null default 'chc',
    confidence       text,
    created_at       timestamptz not null default now(),
    created_by       uuid references public.admin_users(id) on delete set null,
    notes            text,

    constraint company_item_aliases_source_chk
        check (source in ('chc','company','import','auto')),
    constraint company_item_aliases_confidence_chk
        check (confidence is null or confidence in ('exact','barcode','name','manual')),
    -- One shop cannot map the same spelling to two different master parts.
    constraint company_item_aliases_unique
        unique (company_id, alias_sku_key, library_sku_key),
    -- An alias has to say what it is aliasing.
    constraint company_item_aliases_has_a_handle
        check (alias_sku_key is not null or product_id is not null)
);

comment on table public.company_item_aliases is
    'Crossover table: a customer''s own part number or name mapped to the master item. Never changes their catalogue — it only lets reporting group the same part across shops.';
comment on column public.company_item_aliases.approved is
    'False means CHC proposed this mapping and the customer has not confirmed it. Reporting that must not be wrong should use approved aliases only.';

create index if not exists idx_company_item_aliases_company
    on public.company_item_aliases (company_id);
create index if not exists idx_company_item_aliases_library
    on public.company_item_aliases (library_sku_key);
create index if not exists idx_company_item_aliases_product
    on public.company_item_aliases (product_id) where product_id is not null;

alter table public.company_item_aliases enable row level security;
revoke all on public.company_item_aliases from anon, authenticated;

-- ------------------------------------------------------------
-- 5. Resolution — one place to ask "what part is this, really?"
--
-- Three ways a shop's product finds its master item, in order of trust:
--   1. its SKU normalises to a library sku_key         (exact)
--   2. an approved alias says so                        (alias)
--   3. an unapproved alias proposes it                  (proposed)
-- Anything else is unmatched, and unmatched is reported rather than hidden —
-- a product missing from cross-shop reporting with no explanation is worse
-- than one listed as needing a mapping.
-- ------------------------------------------------------------
create or replace view public.v_product_master
with (security_invoker = true) as
select
    p.id                              as product_id,
    p.company_id,
    c.name                            as company_name,
    p.sku                             as company_sku,
    p.name                            as company_name_for_item,
    p.price,
    p.is_active,
    upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g')) as product_sku_key,
    coalesce(direct.sku_key, viaalias.sku_key)            as library_sku_key,
    coalesce(direct.sku,     viaalias.sku)                as master_sku,
    coalesce(direct.name,    viaalias.name)               as master_name,
    coalesce(direct.brand,   viaalias.brand)              as master_brand,
    coalesce(direct.category, viaalias.category)          as master_category,
    coalesce(direct.barcode, viaalias.barcode)            as master_barcode,
    coalesce(direct.list_price, viaalias.list_price)      as master_list_price,
    case
        when direct.sku_key is not null then 'exact'
        when a.id is not null and a.approved then 'alias'
        when a.id is not null then 'proposed'
        else 'unmatched'
    end                                                    as match_type
  from public.products p
  join public.companies c on c.id = p.company_id
  left join public.item_library direct
         on direct.sku_key = upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g'))
  left join public.company_item_aliases a
         on a.company_id = p.company_id
        and direct.sku_key is null
        and (a.product_id = p.id
             or a.alias_sku_key = upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g')))
  left join public.item_library viaalias
         on viaalias.sku_key = a.library_sku_key;

comment on view public.v_product_master is
    'Every shop product resolved to its master item, by exact SKU or by alias. match_type says how — exact, alias, proposed or unmatched — so a number can never be quoted without knowing how it was grouped.';

-- ------------------------------------------------------------
-- 6. How well each customer's catalogue lines up. This is the screen that
--    tells you how much crossover work is left, per shop.
-- ------------------------------------------------------------
create or replace view public.v_catalogue_alignment
with (security_invoker = true) as
select
    company_id,
    company_name,
    count(*)                                                   as products,
    count(*) filter (where match_type = 'exact')               as matched_exact,
    count(*) filter (where match_type = 'alias')               as matched_by_alias,
    count(*) filter (where match_type = 'proposed')            as proposed_aliases,
    count(*) filter (where match_type = 'unmatched')           as unmatched,
    count(*) filter (where master_barcode is not null
                       and master_barcode <> '')               as master_has_barcode,
    round(100.0 * count(*) filter (where match_type in ('exact','alias'))
          / nullif(count(*), 0), 1)                            as pct_resolved
  from public.v_product_master
 where is_active
 group by company_id, company_name;

comment on view public.v_catalogue_alignment is
    'Per customer: how much of their catalogue resolves to the master table, and how much still needs a crossover mapping.';

-- ------------------------------------------------------------
-- 7. Catalogue exclusions
--
-- The master table is the default: an item added to it can be pushed to every
-- customer, so naming, part numbers and barcodes stay identical everywhere and
-- cross-shop reporting means something.
--
-- Exclusions are the exception to that default, and they are commercial, not
-- technical. CHC has no PPG contract covering Assured, so the PPG lines must
-- never reach that one customer's catalogue — while every other brand does,
-- and every other customer gets PPG.
--
-- This is a table rather than a condition in code because the reason lives
-- with the rule. A future "no contract" case is a row somebody adds, not a
-- deploy, and anyone looking at why a customer cannot see a brand finds the
-- answer written down next to it.
-- ------------------------------------------------------------
create table if not exists public.company_catalogue_exclusions (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references public.companies(id) on delete cascade,

    -- Exactly one dimension per row, so a rule can always be read as one
    -- sentence: "this customer does not get <brand|category|part>".
    brand       text,
    category    text,
    sku_key     text,

    reason      text not null,
    created_at  timestamptz not null default now(),
    created_by  uuid references public.admin_users(id) on delete set null,

    constraint company_catalogue_exclusions_one_dimension check (
        (brand is not null)::int + (category is not null)::int + (sku_key is not null)::int = 1
    )
);

comment on table public.company_catalogue_exclusions is
    'Which parts of the master table a customer must NOT receive, and why. Commercial rules — e.g. a brand CHC has no contract to supply to that customer.';
comment on column public.company_catalogue_exclusions.reason is
    'Written for the next person. "No PPG contract for this customer", not "excluded".';

create unique index if not exists uq_company_exclusion_brand
    on public.company_catalogue_exclusions (company_id, brand) where brand is not null;
create unique index if not exists uq_company_exclusion_category
    on public.company_catalogue_exclusions (company_id, category) where category is not null;
create unique index if not exists uq_company_exclusion_sku
    on public.company_catalogue_exclusions (company_id, sku_key) where sku_key is not null;

alter table public.company_catalogue_exclusions enable row level security;
revoke all on public.company_catalogue_exclusions from anon, authenticated;

-- Seed the one rule that exists today. Matched by name rather than by a
-- hard-coded id, and it does nothing at all if no such customer is found —
-- a migration that invents a rule for the wrong company would be worse than
-- one that quietly adds none.
do $$
declare
    target uuid;
begin
    select id into target from public.companies
     where name ilike 'assured%' order by created_at limit 1;

    if target is not null then
        insert into public.company_catalogue_exclusions (company_id, brand, reason)
        values (target, 'PPG', 'CHC has no PPG contract covering this customer. PPG lines must not appear in their catalogue.')
        on conflict do nothing;
    else
        raise notice 'No company matching "Assured" found — no PPG exclusion was created. Add it from the Master Table screen.';
    end if;
end $$;

-- ------------------------------------------------------------
-- 8. What each customer is entitled to receive from the master table.
--
-- The push-to-company action reads this rather than deciding for itself, so
-- the screen that previews a push and the code that performs it cannot
-- disagree about who gets what.
-- ------------------------------------------------------------
-- Dropped first, not replaced. CREATE OR REPLACE VIEW can only APPEND
-- columns; migration 030 inserts push_mode ahead of entitled, and a
-- replace would be refused. Dropping keeps the two migrations runnable in
-- any order and any number of times.
drop view if exists public.v_company_catalogue_entitlement;

create or replace view public.v_company_catalogue_entitlement
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
    (x.id is null)      as entitled,
    x.reason            as excluded_reason
  from public.companies c
 cross join public.item_library l
  left join public.company_catalogue_exclusions x
         on x.company_id = c.id
        and (   (x.brand    is not null and lower(x.brand)    = lower(l.brand))
             or (x.category is not null and lower(x.category) = lower(l.category))
             or (x.sku_key  is not null and x.sku_key         = l.sku_key))
 where c.is_active
   and l.is_active;

comment on view public.v_company_catalogue_entitlement is
    'Every master item against every customer, with entitled=false and a reason where a commercial rule says they must not receive it.';
