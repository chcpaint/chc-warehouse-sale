-- ============================================================
-- 027 - Kit billing: what a kit costs, and whether it can be billed at all
--
-- Migration 026 loaded the kit lines. Consuming a kit already prices itself
-- correctly - routes/inventory-kits.js reads each line's product price off the
-- consuming company's own list and writes the sum to kit_consumptions.total_cost
-- - which is the right behaviour: a kit consumed for one shop must bill at that
-- shop's price, never at a number frozen from somebody else's catalogue.
--
-- What was missing is everything AROUND that number:
--
--   1. No reference to check it against. Skyline shows a unit price and an
--      extended price on every kit line. Those are stored here as reference
--      columns so a total that comes out wrong is visible instead of merely
--      being paid.
--
--   2. No way to see, before a job, whether a kit is billable for a given shop.
--      A line that is unresolved, excluded, or resolved to a product with no
--      price silently contributes zero to the total. The kit still consumes and
--      still posts - it just under-bills, and nothing says so.
--
-- v_kit_billing answers both: per company, per kit, what it will bill, what
-- Skyline says it should be, and whether every line is actually priced.
--
-- Reference prices are NOT used for billing anywhere and must not be. They are
-- a second opinion, nothing more.
--
-- Safe to re-run.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. The reference numbers, as supplied on Skyline's kit screens
-- ------------------------------------------------------------

alter table public.kit_items
    add column if not exists ref_unit_price numeric,
    add column if not exists ref_line_total numeric,
    add column if not exists ref_source     text;

comment on column public.kit_items.ref_unit_price is
    'Unit price shown for this line on the source system''s kit screen. Reference only - never used to bill.';
comment on column public.kit_items.ref_line_total is
    'Extended price shown for this line on the source system. quantity x ref_unit_price.';
comment on column public.kit_items.ref_source is
    'Where the reference price came from, e.g. ''skyline''. NULL means no second opinion exists for this line.';

alter table public.kit_items drop constraint if exists kit_items_ref_price_chk;
alter table public.kit_items
    add constraint kit_items_ref_price_chk check (
        (ref_unit_price is null or ref_unit_price >= 0) and
        (ref_line_total is null or ref_line_total >= 0)
    );

create temporary table _kit_ref (
    kit_name   text not null,
    sku        text not null,
    unit_price numeric not null,
    line_total numeric not null
) on commit drop;

insert into _kit_ref (kit_name, sku, unit_price, line_total) values
    ('Hood Replace', 'MMM08852', 50.99, 20.4),
    ('Hood Replace', 'FUS123EZ', 133.8, 133.8),
    ('Hood Replace', 'PRF611N', 189.99, 1.9),
    ('Door Skin', 'PRF350', 297.99, 89.4),
    ('Door Skin', 'MMM08852', 50.99, 15.3),
    ('Door Skin', 'FUS123EZ', 133.8, 107.04),
    ('Door Skin', 'PRF611N', 189.99, 3.8),
    ('Door Shell', 'PRF350', 297.99, 89.4),
    ('Door Shell', 'MMM08852', 50.99, 15.3),
    ('Door Shell', 'FUS123EZ', 133.8, 120.42),
    ('Door Shell', 'PRF611N', 189.99, 3.8),
    ('Bumper - Structural Repair - Small', 'FUS700', 59.41, 5.94),
    ('Bumper - Structural Repair - Small', 'FUS602EZ', 86.44, 12.97),
    ('Bumper - Structural Repair - Small', 'FUS114LG', 145.38, 36.34),
    ('Bumper - Structural Repair - Small', 'PRF611N', 189.99, 1.9),
    ('Bumper - Structural Repair - Large', 'FUS700', 59.41, 5.94),
    ('Bumper - Structural Repair - Large', 'FUS602EZ', 86.44, 17.29),
    ('Bumper - Structural Repair - Large', 'FUS114LG', 145.38, 72.69),
    ('Bumper - Structural Repair - Large', 'PRF611N', 189.99, 3.8),
    ('Bumper - Cosmetic Repair - Small', 'FUS602EZ', 86.44, 8.64),
    ('Bumper - Cosmetic Repair - Small', 'FUS114LG', 145.38, 36.34),
    ('Bumper - Cosmetic Repair - Small', 'PRF611N', 189.99, 1.9),
    ('Bumper - Cosmetic Repair - Large', 'FUS602EZ', 86.44, 12.97),
    ('Bumper - Cosmetic Repair - Large', 'FUS114LG', 145.38, 145.38),
    ('Bumper - Cosmetic Repair - Large', 'PRF611N', 189.99, 1.9),
    ('Body Side Repair', 'MMM08852', 50.99, 20.4),
    ('Body Side Repair', 'FUS2098', 459.99, 230.0),
    ('Body Side Repair', 'FUS130SM', 143.99, 43.2),
    ('Body Side Repair', 'FUS129SM', 143.99, 86.39),
    ('Body Side Repair', 'FUS123EZ', 133.8, 80.28),
    ('Body Side Repair', 'PRF611N', 189.99, 7.6),
    ('Body Side Repair', 'FUS208B', 303.99, 212.79),
    ('Bed Side Repair', 'MMM08852', 50.99, 15.3),
    ('Bed Side Repair', 'FUS130SM', 143.99, 28.8),
    ('Bed Side Repair', 'FUS123EZ', 133.8, 26.76),
    ('Bed Side Repair', 'PRF611N', 189.99, 3.8),
    ('Bed Side Repair', 'FUS208B', 303.99, 91.2),
    ('Bed Liner', 'UPO8405', 271.11, 271.11),
    ('Apron Repair', 'FUS2098', 459.99, 367.99),
    ('Apron Repair', 'FUS123EZ', 133.8, 26.76),
    ('Apron Repair', 'PRF611N', 189.99, 3.8),
    ('A/B/C Pillar', 'MMM08852', 50.99, 15.3),
    ('A/B/C Pillar', 'FUS130SM', 143.99, 143.99),
    ('A/B/C Pillar', 'PRF611N', 189.99, 3.8),
    ('A/B/C Pillar', 'FUS208B', 303.99, 303.99);

update public.kit_items i
   set ref_unit_price = r.unit_price,
       ref_line_total = r.line_total,
       ref_source     = 'skyline'
  from _kit_ref r
  join public.repair_kits k
    on k.company_id is null and lower(k.name) = lower(r.kit_name)
 where i.kit_id = k.id
   and upper(regexp_replace(i.sku, '[^A-Za-z0-9]', '', 'g'))
     = upper(regexp_replace(r.sku, '[^A-Za-z0-9]', '', 'g'));

-- The reference extended price must equal quantity x unit price, or one of the
-- two was transcribed wrong and the whole comparison is worthless.
do $$
declare bad text;
begin
    select string_agg(k.name || ' / ' || i.sku, ', ')
      into bad
      from public.kit_items i
      join public.repair_kits k on k.id = i.kit_id
     where i.ref_source = 'skyline'
       and abs(i.ref_line_total - (i.quantity * i.ref_unit_price)) > 0.01;
    if bad is not null then
        raise exception 'Reference totals do not reconcile to quantity x price: %', bad;
    end if;
end $$;

-- ------------------------------------------------------------
-- 2. Is this kit billable for this shop, and for how much?
--
-- One row per company per master kit they have access to. A line counts as
-- billable only when it resolves to a product that carries a price above zero;
-- excluded lines are legitimately skipped and are not counted as missing.
-- ------------------------------------------------------------

create or replace view public.v_kit_billing as
with line as (
    select
        a.company_id,
        k.id                                   as kit_id,
        k.name                                 as kit_name,
        i.id                                   as kit_item_id,
        i.sku,
        coalesce(m.quantity, i.quantity)       as qty,
        m.is_excluded,
        m.product_id                           as mapped_product_id,
        p.price                                as unit_price,
        i.ref_unit_price,
        i.ref_line_total,
        i.needs_review
      from public.company_kit_access a
      join public.repair_kits k  on k.id = a.kit_id and k.company_id is null
      join public.kit_items   i  on i.kit_id = k.id
      left join public.kit_product_map m
             on m.kit_item_id = i.id and m.company_id = a.company_id
      left join public.products p
             on p.id = m.product_id and p.company_id = a.company_id and p.is_active
)
select
    company_id,
    kit_id,
    kit_name,
    count(*)                                                   as line_count,
    count(*) filter (where is_excluded)                        as excluded_lines,
    count(*) filter (where not coalesce(is_excluded,false)
                       and mapped_product_id is null)          as unresolved_lines,
    count(*) filter (where not coalesce(is_excluded,false)
                       and mapped_product_id is not null
                       and coalesce(unit_price,0) <= 0)        as unpriced_lines,
    count(*) filter (where needs_review)                       as review_lines,

    -- What a consume would actually bill today.
    round(coalesce(sum(qty * unit_price)
          filter (where not coalesce(is_excluded,false)
                    and mapped_product_id is not null), 0), 2) as billable_total,

    -- What the source system says the same kit comes to.
    round(coalesce(sum(ref_line_total)
          filter (where not coalesce(is_excluded,false)), 0), 2) as reference_total,

    round(coalesce(sum(qty * unit_price)
          filter (where not coalesce(is_excluded,false)
                    and mapped_product_id is not null), 0)
        - coalesce(sum(ref_line_total)
          filter (where not coalesce(is_excluded,false)), 0), 2) as variance,

    -- Billable only when nothing is unresolved and nothing is priced at zero.
    (count(*) filter (where not coalesce(is_excluded,false)
                        and (mapped_product_id is null or coalesce(unit_price,0) <= 0)) = 0)
                                                               as is_billable
  from line
 group by company_id, kit_id, kit_name;

comment on view public.v_kit_billing is
    'Per company per master kit: what a consume would bill today from that company''s own prices, what the source system says it should be, and whether every line is resolved and priced. reference_total is a second opinion and is never billed.';

-- Same posture as every other object here: service role only. Guarded so the
-- migration can also be applied to a plain Postgres, where Supabase's `anon`
-- and `authenticated` roles do not exist.
do $$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on public.v_kit_billing from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on public.v_kit_billing from authenticated';
    end if;
end $$;

-- ------------------------------------------------------------
-- 3. Report
-- ------------------------------------------------------------

do $$
declare priced int; unreconciled int;
begin
    select count(*) into priced from public.kit_items where ref_source = 'skyline';
    select count(*) into unreconciled
      from public.kit_items i join public.repair_kits k on k.id = i.kit_id
     where k.company_id is null and k.source = 'chc' and i.ref_source is null;
    raise notice 'Reference prices on % lines | % master kit lines still without one', priced, unreconciled;
end $$;

commit;
