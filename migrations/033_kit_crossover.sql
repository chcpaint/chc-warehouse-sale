-- ============================================================================
-- 033_kit_crossover.sql
--
-- Two problems, two tables.
--
-- 1. CHC has a reference sheet -- for a given Fusor adhesive, what Norton,
--    3M, SEM, Kent or Wurth part does the same job. That sheet is master
--    reference data: it does not belong to any kit or any customer, it is
--    just "what the world offers instead of Fusor." product_crossover_reference
--    holds it, searchable, so curating a kit line means picking from a real
--    list instead of typing a part number from memory.
--
-- 2. A kit line still only means one thing until someone decides otherwise.
--    kit_item_alternatives is that decision, once per line: "this line can
--    also be filled with Norton 6420" -- reviewed and attached by a person,
--    the same discipline as kit_product_map's own suggestions, because a
--    wrong crossover is worse than none. It may reference the row in the
--    lookup table it came from (traceability), or stand alone when someone
--    typed it in directly.
--
-- A customer's actual choice among a line's alternatives, and what they pay
-- for it, is per-company data -- it belongs on kit_product_map, which already
-- is per-company data for this exact line, not on a new table.
--
-- Safe to run more than once. No temp tables, no transaction control.
-- Checked with qa/migrations-smoke.sh.
-- ============================================================================

create table if not exists public.product_crossover_reference (
    id                 uuid primary key default gen_random_uuid(),

    base_brand         text not null,
    base_category      text,
    base_name          text,
    base_part_number   text not null,
    base_speed         text,
    base_size          text,

    alt_brand          text not null,
    alt_product_line   text,
    alt_name           text,
    alt_part_number    text,
    alt_speed          text,
    alt_size           text,

    sheet_name         text,
    source_file        text,
    imported_at        timestamptz not null default now(),
    imported_by        uuid references public.admin_users(id) on delete set null
);

comment on table public.product_crossover_reference is
    'CHC''s brand-crossover reference sheets (Fusor -> Norton/3M/SEM/Kent/Wurth and whatever is imported after it), flattened for search. Reference data, not tied to any kit or company.';

create index if not exists idx_crossover_reference_base_part
    on public.product_crossover_reference (upper(regexp_replace(base_part_number, '[^A-Za-z0-9]', '', 'g')));
create index if not exists idx_crossover_reference_alt_part
    on public.product_crossover_reference (upper(regexp_replace(alt_part_number, '[^A-Za-z0-9]', '', 'g')))
    where alt_part_number is not null;
create index if not exists idx_crossover_reference_alt_brand on public.product_crossover_reference (alt_brand);

alter table public.product_crossover_reference enable row level security;
revoke all on public.product_crossover_reference from anon, authenticated;

-- ------------------------------------------------------------
-- What a kit line may also be filled with, once a person has looked at the
-- reference sheet (or typed a part in directly) and attached it.
-- ------------------------------------------------------------

create table if not exists public.kit_item_alternatives (
    id                    uuid primary key default gen_random_uuid(),
    kit_item_id           uuid not null references public.kit_items(id) on delete cascade,

    brand                 text not null,
    brand_part_number     text not null,
    brand_name            text,
    speed                 text,
    size                  text,
    notes                 text,

    -- Where this came from, when it came from the reference sheet rather
    -- than being typed in by hand. Kept even if the reference row is later
    -- deleted -- the alternative a customer already uses must not vanish.
    crossover_reference_id uuid references public.product_crossover_reference(id) on delete set null,

    is_active             boolean not null default true,
    sort_order            integer not null default 0,

    created_at            timestamptz not null default now(),
    created_by            uuid references public.admin_users(id) on delete set null,
    updated_at            timestamptz not null default now()
);

comment on table public.kit_item_alternatives is
    'Brand alternatives attached to one kit line, reviewed by a person before they appear as an option. What a customer actually picked is recorded on kit_product_map, not here.';

create index if not exists idx_kit_item_alternatives_item on public.kit_item_alternatives (kit_item_id);

alter table public.kit_item_alternatives enable row level security;
revoke all on public.kit_item_alternatives from anon, authenticated;

-- ------------------------------------------------------------
-- Per-company: which alternative a shop chose for a line, and what they pay
-- for it if that differs from the mapped product's catalogue price.
-- ------------------------------------------------------------

alter table public.kit_product_map
    add column if not exists alternative_id uuid references public.kit_item_alternatives(id) on delete set null,
    add column if not exists unit_price_override numeric;

comment on column public.kit_product_map.alternative_id is
    'Which of the line''s brand alternatives this company chose, purely for display -- product_id is still what actually gets expensed.';
comment on column public.kit_product_map.unit_price_override is
    'What this company is charged per unit of this line, when it differs from the mapped product''s catalogue price. NULL uses the catalogue price.';

alter table public.kit_product_map drop constraint if exists kit_product_map_price_chk;
alter table public.kit_product_map
    add constraint kit_product_map_price_chk check (unit_price_override is null or unit_price_override >= 0);
