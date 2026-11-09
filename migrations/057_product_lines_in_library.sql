-- 057_product_lines_in_library.sql
--
-- EHP, OneChoice and Shopline in the Item Library, and in its search.
--
-- WHAT WAS WRONG
--   These three are PPG product lines. Assured (and others) hold them in their
--   own catalogues, but they were never in the master Item Library, so a search
--   there found nothing. And the library search only looked at a part's name and
--   part number, so even once the items are there a person could not pick
--   "EHP" as a filter.
--
-- WHAT THIS DOES
--   1. Copies each distinct EHP / OneChoice / Shopline part that any company
--      already sells into item_library, once per part number. It reuses the part
--      number, name, brand, category, unit and case quantity the catalogue
--      already holds. No list price is invented: list_price stays empty, which
--      the console shows as "Needs pricing". (A company's own sell price is its
--      own and is never copied into the shared master.)
--   2. Replaces search_item_library with a version that also takes a list of
--      product-line terms and matches words against brand and category too.
--      The old six-argument version is dropped first so the API never sees two
--      functions of the same name.
--
-- WHAT THIS DOES NOT TOUCH
--   - Any company's products, prices, barcodes, users, settings or sign-in
--     (including Assured's access-code login). Only item_library is written.
--   - Any part already in the library, under any spelling: those are skipped.
--
-- Safe to re-run; the second run adds nothing. Everything added is tagged
-- source = 'catalogue_backfill_lines', so it is one DELETE away from undone:
--     delete from public.item_library where source = 'catalogue_backfill_lines';
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and click Run.
-- The result tab at the end counts the library by line.

-- ------------------------------------------------------------------
-- 1. Backfill the library from the catalogues
-- ------------------------------------------------------------------
with line_terms(label, pattern) as (
    values ('EHP',       '(ehp)'),
           ('OneChoice', '(onechoice|one choice|one-choice)'),
           ('Shopline',  '(shopline|shop line|shop-line)')
),
-- Every active catalogue row that belongs to a line, matched the same way the
-- storefront does it: the term anywhere in brand, category, name or part number.
cand as (
    select p.id, p.sku, p.name, p.brand, p.category, p.unit, p.case_qty, p.company_id,
           upper(regexp_replace(coalesce(p.sku, ''), '[^A-Za-z0-9]', '', 'g')) as k,
           c.distributor_id
      from public.products p
      join public.companies c on c.id = p.company_id
     where coalesce(p.sku, '') <> ''
       and coalesce(p.name, '') <> ''
       and coalesce(p.is_active, true)
       and exists (
            select 1 from line_terms t
             where concat_ws(' ', p.brand, p.category, p.name, p.sku) ~* t.pattern)
),
-- One row per (distributor, part number). Prefer the longest name: it is the
-- fullest description of the part.
one as (
    select distinct on (distributor_id, k)
           distributor_id, k, sku, name, brand, category, unit, case_qty, company_id, id as product_id
      from cand
     where k <> ''
     order by distributor_id, k, (sku = upper(sku)) desc, length(name) desc, id
),
-- The supplier code the library already uses for a brand, so a PPG item sorts
-- with the other PPG items in the Supplier filter.
vend as (
    select upper(l.brand) as b, l.vendor_code, count(*) as n
      from public.item_library l
     where l.vendor_code is not null and l.brand is not null
     group by upper(l.brand), l.vendor_code
),
vend_pick as (
    select distinct on (b) b, vendor_code from vend order by b, n desc
)
insert into public.item_library
    (sku, sku_key, name, brand, vendor_code, barcode, barcode_level, unit, case_qty,
     list_price, category, source, notes, is_active, distributor_id)
select o.sku,
       o.k,
       o.name,
       o.brand,
       coalesce(vp.vendor_code,
                nullif(left(upper(regexp_replace(coalesce(o.brand, ''), '[^A-Za-z0-9]', '', 'g')), 10), '')),
       -- A barcode comes across only when it is plain digits, belongs to this
       -- part alone, and is not already used elsewhere in the library.
       bc.barcode,
       case when bc.barcode is null then null
            when length(bc.barcode) = 14 then 'case'
            when length(bc.barcode) in (8, 12, 13) then 'each'
            else 'unknown' end,
       o.unit,
       o.case_qty,
       null,                                   -- no list price: shown as "Needs pricing"
       o.category,
       'catalogue_backfill_lines',
       'Copied from a company catalogue so it can be found in the library. No list price on file - NEEDS PRICING.',
       true,
       o.distributor_id
  from one o
  left join vend_pick vp on vp.b = upper(coalesce(o.brand, ''))
  left join lateral (
        select b.barcode
          from cand c2
          join public.product_barcodes b on b.product_id = c2.id
         where c2.distributor_id = o.distributor_id and c2.k = o.k      -- any company's copy of this part
           and b.barcode ~ '^\d{8,14}$'
           and not exists (select 1 from public.item_library x where x.barcode = b.barcode)
         order by b.is_primary desc nulls last, b.barcode
         limit 1) bc on true
 where not exists (
        select 1 from public.item_library x
         where x.distributor_id = o.distributor_id
           and x.sku_key = o.k);

-- ------------------------------------------------------------------
-- 2. Library search that understands product lines
-- ------------------------------------------------------------------
drop function if exists public.search_item_library(uuid, text, text[], boolean, int, int);

create or replace function public.search_item_library(
    p_company_id uuid,
    p_query      text,
    p_vendors    text[] default null,
    p_only_new   boolean default false,
    p_limit      int default 50,
    p_offset     int default 0,
    p_lines      text[] default null      -- product-line terms, e.g. {ehp,onechoice,"one choice"}
)
returns table (
    id uuid, sku text, name text, brand text, vendor_code text,
    barcode text, unit text, case_qty numeric, list_price numeric,
    already_in_catalogue boolean, existing_product_id uuid, rank real,
    total_count bigint
)
language sql
stable
set search_path = public, extensions, pg_catalog
as $fn$
with q as (
    select
        coalesce(trim(p_query), '')                                          as raw,
        upper(regexp_replace(coalesce(p_query,''), '[^A-Za-z0-9]', '', 'g'))  as key,
        (select coalesce(array_agg(w), '{}')
           from unnest(regexp_split_to_array(lower(coalesce(trim(p_query),'')), '\s+')) w
          where length(w) > 0)                                               as words
),
mine as (
    select p.id,
           upper(regexp_replace(coalesce(p.sku,''), '[^A-Za-z0-9]', '', 'g')) as k
    from products p
    where p.company_id = p_company_id and coalesce(p.sku,'') <> ''
),
hits as (
    select l.*,
           m.id as existing_product_id,
           case
               when q.key <> '' and l.sku_key = q.key                  then 1000.0
               when q.raw <> '' and l.barcode = q.raw                  then 900.0
               when q.key <> '' and l.sku_key like q.key || '%'        then 500.0 + similarity(l.sku_key, q.key)
               when q.key <> '' and l.sku_key like '%' || q.key || '%' then 300.0 + similarity(l.sku_key, q.key)
               else 100.0 + similarity(lower(l.name), lower(q.raw))
           end::real as rank
    from item_library l
    cross join q
    left join mine m on m.k = l.sku_key
    where (p_vendors is null or l.vendor_code = any (p_vendors))
      -- A product line is the term anywhere in brand, category, name or part
      -- number: the same rule the storefront and the Products screen use.
      and (p_lines is null or cardinality(p_lines) = 0 or exists (
            select 1 from unnest(p_lines) t
             where t <> ''
               and lower(concat_ws(' ', l.brand, l.category, l.name, l.sku)) like '%' || lower(t) || '%'))
      and (
            q.raw = ''
            or (q.key <> '' and l.sku_key like '%' || q.key || '%')
            or l.barcode = q.raw
            or (cardinality(q.words) > 0
                and not exists (
                    select 1 from unnest(q.words) w
                    where lower(concat_ws(' ', l.name, l.sku, l.brand, l.category)) not like '%' || w || '%'
                ))
          )
      and (not p_only_new or m.id is null)
)
select h.id, h.sku, h.name, h.brand, h.vendor_code, h.barcode, h.unit,
       h.case_qty, h.list_price,
       (h.existing_product_id is not null) as already_in_catalogue,
       h.existing_product_id,
       h.rank,
       count(*) over () as total_count
from hits h
order by h.rank desc nulls last, h.sku
limit greatest(1, least(coalesce(p_limit, 50), 200))
offset greatest(0, coalesce(p_offset, 0));
$fn$;

revoke all on function public.search_item_library(uuid, text, text[], boolean, int, int, text[])
    from public, anon, authenticated;

-- ------------------------------------------------------------------
-- The answer: how many library parts sit in each line now.
-- ------------------------------------------------------------------
select t.label as product_line, count(l.id) as parts_in_library,
       count(l.id) filter (where l.list_price is null) as needing_pricing
  from (values ('EHP', 'ehp'), ('OneChoice', 'onechoice|one choice|one-choice'),
               ('Shopline', 'shopline|shop line|shop-line')) as t(label, pat)
  left join public.item_library l
         on concat_ws(' ', l.brand, l.category, l.name, l.sku) ~* t.pat
 group by t.label
 order by t.label;
