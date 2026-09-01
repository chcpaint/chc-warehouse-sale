-- ============================================================
-- 026 - Skyline repair kits, rebuilt on CHC part numbers
--
-- Migration 016 documented 15 kits already sitting in `repair_kits` from an
-- earlier Skyline export: every line had product_id NULL and 13 of their 17
-- SKUs were Skyline part numbers we do not stock. They were never usable.
--
-- This replaces them with 12 kits read off Skyline's current Repair Kits
-- screens, with every line rewritten to the CHC part number it resolves to.
-- Kit names are kept exactly as Skyline writes them, so the two systems can be
-- compared line for line.
--
-- All 12 are CHC master kits (company_id NULL), offered to shops through
-- company_kit_access. Quantities are fractions of a unit - a door skin burns
-- 0.8 of a seam sealer cartridge - which is how Skyline expenses them.
--
-- TWO LINES ARE SUBSTITUTIONS, NOT EXACT MATCHES. Both are flagged
-- needs_review = true so they surface on the mapping screen:
--   FUS602  -> FUS602EZ  Norton 9oz Plastic/Bumper Surface Modifier.
--                        Only FUS6-series part we carry; description agrees,
--                        but Skyline prices it at $86.44 against our $44.99,
--                        near enough to double to suspect a size difference.
--   UP8405  -> UPO8405   U-POL Raptor Bottle Kit Black. Digits match and no
--                        other 8405 exists; Skyline calls it "Upol Bed Liner
--                        - Black" at $271.11 against our $220.00.
--
-- The other 10 part numbers matched the Item Library exactly, and six of them
-- (FUS129SM, FUS130SM, FUS208B, FUS2098, PRF350, PRF611N) carry the identical
-- list price on both sides - good evidence the two houses read one catalogue.
--
-- Safe to re-run: kits are matched by name, their lines rebuilt each time.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. Retire the 2024 import rather than delete it
--
-- Deleting would cascade kit_product_map and orphan any kit_consumptions that
-- reference these ids. Retiring leaves history intact and takes them off the
-- counter. Only the unusable master kits are touched - never a shop's own.
-- ------------------------------------------------------------

update public.repair_kits
   set is_active = false,
       updated_at = now()
 where company_id is null
   and is_active = true
   and id in (
       select k.id from public.repair_kits k
        where k.company_id is null
          and exists (select 1 from public.kit_items i
                       where i.kit_id = k.id and i.product_id is null)
          and not exists (select 1 from public.products p
                           where upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g'))
                               = upper(regexp_replace((select i2.sku from public.kit_items i2
                                                        where i2.kit_id = k.id limit 1),
                                                      '[^A-Za-z0-9]', '', 'g')))
   );

-- ------------------------------------------------------------
-- 2. The kits themselves
-- ------------------------------------------------------------

-- A permanent scratch table, not a temporary one. The Supabase SQL editor
-- runs statements over a pooled connection with autocommit, so a TEMP table
-- with ON COMMIT DROP is gone before the next statement can read it. This is
-- dropped explicitly at the end instead.
drop table if exists public._kit_load_scratch;
create table public._kit_load_scratch (
    kit_name  text not null,
    sku       text not null,
    quantity  numeric not null,
    sort_order integer not null,
    review    boolean not null default false
);
-- Locked down in case a failed run ever leaves it behind.
alter table public._kit_load_scratch enable row level security;

insert into public._kit_load_scratch (kit_name, sku, quantity, sort_order, review) values
    ('Hood Replace', 'MMM08852', 0.4, 1, false),
    ('Hood Replace', 'FUS123EZ', 1.0, 2, false),
    ('Hood Replace', 'PRF611N', 0.01, 3, false),
    ('Door Skin', 'PRF350', 0.3, 1, false),
    ('Door Skin', 'MMM08852', 0.3, 2, false),
    ('Door Skin', 'FUS123EZ', 0.8, 3, false),
    ('Door Skin', 'PRF611N', 0.02, 4, false),
    ('Door Shell', 'PRF350', 0.3, 1, false),
    ('Door Shell', 'MMM08852', 0.3, 2, false),
    ('Door Shell', 'FUS123EZ', 0.9, 3, false),
    ('Door Shell', 'PRF611N', 0.02, 4, false),
    ('Bumper - Structural Repair - Small', 'FUS700', 0.1, 1, false),
    ('Bumper - Structural Repair - Small', 'FUS602EZ', 0.15, 2, true),  -- Skyline: FUS602
    ('Bumper - Structural Repair - Small', 'FUS114LG', 0.25, 3, false),
    ('Bumper - Structural Repair - Small', 'PRF611N', 0.01, 4, false),
    ('Bumper - Structural Repair - Large', 'FUS700', 0.1, 1, false),
    ('Bumper - Structural Repair - Large', 'FUS602EZ', 0.2, 2, true),  -- Skyline: FUS602
    ('Bumper - Structural Repair - Large', 'FUS114LG', 0.5, 3, false),
    ('Bumper - Structural Repair - Large', 'PRF611N', 0.02, 4, false),
    ('Bumper - Cosmetic Repair - Small', 'FUS602EZ', 0.1, 1, true),  -- Skyline: FUS602
    ('Bumper - Cosmetic Repair - Small', 'FUS114LG', 0.25, 2, false),
    ('Bumper - Cosmetic Repair - Small', 'PRF611N', 0.01, 3, false),
    ('Bumper - Cosmetic Repair - Large', 'FUS602EZ', 0.15, 1, true),  -- Skyline: FUS602
    ('Bumper - Cosmetic Repair - Large', 'FUS114LG', 1.0, 2, false),
    ('Bumper - Cosmetic Repair - Large', 'PRF611N', 0.01, 3, false),
    ('Body Side Repair', 'MMM08852', 0.4, 1, false),
    ('Body Side Repair', 'FUS2098', 0.5, 2, false),
    ('Body Side Repair', 'FUS130SM', 0.3, 3, false),
    ('Body Side Repair', 'FUS129SM', 0.6, 4, false),
    ('Body Side Repair', 'FUS123EZ', 0.6, 5, false),
    ('Body Side Repair', 'PRF611N', 0.04, 6, false),
    ('Body Side Repair', 'FUS208B', 0.7, 7, false),
    ('Bed Side Repair', 'MMM08852', 0.3, 1, false),
    ('Bed Side Repair', 'FUS130SM', 0.2, 2, false),
    ('Bed Side Repair', 'FUS123EZ', 0.2, 3, false),
    ('Bed Side Repair', 'PRF611N', 0.02, 4, false),
    ('Bed Side Repair', 'FUS208B', 0.3, 5, false),
    ('Bed Liner', 'UPO8405', 1.0, 1, true),  -- Skyline: UP8405
    ('Apron Repair', 'FUS2098', 0.8, 1, false),
    ('Apron Repair', 'FUS123EZ', 0.2, 2, false),
    ('Apron Repair', 'PRF611N', 0.02, 3, false),
    ('A/B/C Pillar', 'MMM08852', 0.3, 1, false),
    ('A/B/C Pillar', 'FUS130SM', 1.0, 2, false),
    ('A/B/C Pillar', 'PRF611N', 0.02, 3, false),
    ('A/B/C Pillar', 'FUS208B', 1.0, 4, false);

-- Sanity: every SKU we are about to reference must exist in the Item Library.
-- If one does not, the kit would load as an unresolvable line, so stop instead.
do $$
declare missing text;
begin
    select string_agg(distinct l.sku, ', ')
      into missing
      from public._kit_load_scratch l
     where not exists (
           select 1 from public.item_library il
            where il.sku_key = upper(regexp_replace(l.sku, '[^A-Za-z0-9]', '', 'g')));
    if missing is not null then
        raise exception 'These kit SKUs are not in item_library: %', missing;
    end if;
end $$;

-- Upsert the kit headers.
insert into public.repair_kits (company_id, name, description, source, is_active, sort_order)
select null,
       l.kit_name,
       'Imported from Skyline Repair Kits, ' || to_char(now(), 'DD Mon YYYY') || '. CHC part numbers.',
       'chc',
       true,
       100 + row_number() over (order by l.kit_name)
  from (select distinct kit_name from public._kit_load_scratch) l
 where not exists (select 1 from public.repair_kits k
                    where k.company_id is null and lower(k.name) = lower(l.kit_name));

update public.repair_kits k
   set is_active = true, source = 'chc', updated_at = now()
  from (select distinct kit_name from public._kit_load_scratch) l
 where k.company_id is null and lower(k.name) = lower(l.kit_name);

-- Rebuild the lines. Dropping and reinserting keeps the migration re-runnable;
-- kit_product_map rows hanging off old line ids cascade away with them, which
-- is correct - a line that no longer exists has nothing left to resolve to.
delete from public.kit_items i
 using public.repair_kits k, (select distinct kit_name from public._kit_load_scratch) l
 where i.kit_id = k.id and k.company_id is null and lower(k.name) = lower(l.kit_name);

insert into public.kit_items (kit_id, sku, product_id, quantity, unit, sort_order, needs_review)
select k.id, l.sku, null, l.quantity, 'each', l.sort_order, l.review
  from public._kit_load_scratch l
  join public.repair_kits k
    on k.company_id is null and lower(k.name) = lower(l.kit_name);

-- ------------------------------------------------------------
-- 3. Resolve each line to the product on each shop's own shelf
--
-- A master kit line is a SKU string; products are per-company. Where a company
-- already stocks that exact SKU we can record the resolution now rather than
-- make someone map 48 lines by hand for every shop. Anything that does not
-- match is left unresolved on purpose - the mapping screen is where a person
-- decides, and an unresolved line refuses at the counter rather than guessing.
-- ------------------------------------------------------------

insert into public.kit_product_map (company_id, kit_item_id, product_id, quantity, is_excluded)
select p.company_id, i.id, p.id, null, false
  from public.kit_items i
  join public.repair_kits k on k.id = i.kit_id and k.company_id is null
  join public.products p
    on upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g'))
     = upper(regexp_replace(i.sku, '[^A-Za-z0-9]', '', 'g'))
   and p.is_active = true
 where exists (select 1 from public._kit_load_scratch l where lower(l.kit_name) = lower(k.name))
on conflict (company_id, kit_item_id) do nothing;

-- ------------------------------------------------------------
-- 4. Offer the kits to every active company, switched OFF
--
-- Enabled defaults to false deliberately. A kit that is on but unmapped
-- refuses at the counter, which reads to a shop as a broken screen. CHC turns
-- each one on from the console once its lines resolve.
-- ------------------------------------------------------------

insert into public.company_kit_access (company_id, kit_id, enabled)
select c.id, k.id, false
  from public.companies c
 cross join public.repair_kits k
 where k.company_id is null
   and exists (select 1 from public._kit_load_scratch l where lower(l.kit_name) = lower(k.name))
on conflict (company_id, kit_id) do nothing;

-- ------------------------------------------------------------
-- 5. Report
-- ------------------------------------------------------------

do $$
declare kits int; lines int; resolved int; unresolved int;
begin
    select count(*) into kits
      from public.repair_kits k where k.company_id is null and k.source = 'chc' and k.is_active;
    select count(*) into lines
      from public.kit_items i join public.repair_kits k on k.id = i.kit_id
     where k.company_id is null and k.source = 'chc';
    select count(*) into resolved   from public.kit_product_map where product_id is not null;
    select count(*) into unresolved
      from public.kit_items i
      join public.repair_kits k on k.id = i.kit_id and k.company_id is null and k.source = 'chc'
     cross join public.companies c
     where not exists (select 1 from public.kit_product_map m
                        where m.kit_item_id = i.id and m.company_id = c.id);
    raise notice 'Kits % | lines % | resolved company-lines % | still unmapped %',
        kits, lines, resolved, unresolved;
end $$;

-- Scratch table has done its job.
drop table if exists public._kit_load_scratch;

commit;
