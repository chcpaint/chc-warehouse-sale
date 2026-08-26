-- 023_item_library_search.sql
--
-- One function behind the Item Library screen.
--
-- WHY IT IS A FUNCTION RATHER THAN A QUERY IN THE ROUTE
--
-- The screen needs two things at once: the matching parts, and whether the
-- company doing the looking already sells each one. Done as two round trips,
-- there is a window where the second answer is stale, and the visible symptom
-- is the console offering to add a SKU the shop already has — which produces a
-- duplicate part number in a live store that nobody notices until two lines
-- show up on one order. One query, one answer.
--
-- HOW A PERSON ACTUALLY SEARCHES
--
-- Four shapes, in the order they are worth:
--
--   MMM31371            the exact part number
--   051131313712        a barcode, usually scanned
--   mmm-313             part of a part number, punctuation however they typed it
--   cubitron file belt  words they remember from the description
--
-- The last one is why matching is per word rather than per phrase: nobody types
-- "3M Cubitron II File Belt P36 3/8in", so requiring the whole string as one
-- substring would return nothing for the search people are most likely to run.
--
-- Trigram indexes carry the partial-SKU and description matching. The tsvector
-- index from migration 021 is left in place; it costs little and covers the
-- word-prefix case if this ever moves to a ranked full-text search.

-- pg_trgm lives in `extensions`, alongside pgcrypto and uuid-ossp, rather than
-- in `public` where the shops' own data lives.
create schema if not exists extensions;
create extension if not exists pg_trgm schema extensions;

create index if not exists idx_item_library_sku_trgm
    on public.item_library using gin (sku_key extensions.gin_trgm_ops);
create index if not exists idx_item_library_name_trgm
    on public.item_library using gin (name extensions.gin_trgm_ops);

create or replace function public.search_item_library(
    p_company_id uuid,
    p_query      text,
    p_vendors    text[] default null,
    p_only_new   boolean default false,
    p_limit      int default 50,
    p_offset     int default 0
)
returns table (
    id uuid, sku text, name text, brand text, vendor_code text,
    barcode text, unit text, case_qty numeric, list_price numeric,
    already_in_catalogue boolean, existing_product_id uuid, rank real,
    total_count bigint
)
language sql
stable
-- Pinned so the schemas the unqualified names resolve to do not depend on who
-- is calling.
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
           -- Exact beats barcode beats prefix beats contains beats description,
           -- so typing a full part number never buries it under a description
           -- that happens to contain the same digits.
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
      and (
            q.raw = ''
            or (q.key <> '' and l.sku_key like '%' || q.key || '%')
            or l.barcode = q.raw
            or (cardinality(q.words) > 0
                and not exists (
                    select 1 from unnest(q.words) w
                    where lower(l.name) not like '%' || w || '%'
                      and lower(l.sku)  not like '%' || w || '%'
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

-- Service role only, like everything else that reads across companies.
revoke all on function public.search_item_library(uuid, text, text[], boolean, int, int)
    from public, anon, authenticated;
