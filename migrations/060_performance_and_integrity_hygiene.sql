-- ============================================================================
-- 060_performance_and_integrity_hygiene.sql
--
-- Clears the findings of the Supabase performance and security advisors that
-- are safe to clear without changing behaviour, and closes one race in the
-- scan-out kiosk. Safe to run more than once. Changes no data.
--
--   A. Index every foreign key that has no covering index (the advisor listed
--      56). Without them, deleting or joining on a parent row scans the child
--      table; harmless at today's size, slow at thousands of shops.
--   B. Drop two indexes that duplicate another one exactly.
--   C. Pin the search path on two functions the security advisor flagged.
--   D. One kiosk basket may post a given product only once, even if the same
--      request arrives twice at the same instant. routes/kiosk.js treats the
--      resulting unique violation as "already done".
--
-- Run it in the Supabase SQL editor when the shops are quiet: building an index
-- briefly blocks writes to that table (a second or less at current sizes).
-- ============================================================================

-- A. Foreign keys without a covering index ----------------------------------
do $$
declare
    r record;
    cols text;
    made int := 0;
begin
    for r in
        select c.oid as con_oid, c.conname, c.conrelid, c.conrelid::regclass as tbl, c.conkey
          from pg_constraint c
         where c.contype = 'f'
           and c.connamespace = 'public'::regnamespace
           and not exists (
               select 1 from pg_index i
                where i.indrelid = c.conrelid
                  and i.indisvalid
                  and i.indpred is null
                  and (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] = c.conkey
           )
    loop
        select string_agg(quote_ident(a.attname), ', ' order by array_position(r.conkey, a.attnum))
          into cols
          from pg_attribute a
         where a.attrelid = r.conrelid and a.attnum = any (r.conkey);

        execute format('create index if not exists %I on %s (%s)', left('idx_fk_' || r.conname, 63), r.tbl, cols);
        made := made + 1;
    end loop;
    raise notice 'foreign-key indexes created: %', made;
end $$;

-- B. Exact duplicate indexes -------------------------------------------------
-- Keep the more descriptive name; drop the other only if both exist.
do $$
begin
    if to_regclass('public.idx_orders_company_created') is not null and to_regclass('public.idx_orders_date') is not null then
        drop index public.idx_orders_date;
    end if;
    if to_regclass('public.idx_kit_consumptions_company_created') is not null and to_regclass('public.idx_kit_consumptions_created') is not null then
        drop index public.idx_kit_consumptions_created;
    end if;
end $$;

-- C. Fixed search path on the two flagged functions --------------------------
do $$
declare f record;
begin
    for f in
        select p.oid::regprocedure as sig
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('next_kit_submission_no', 'kit_submissions_guard')
    loop
        execute format('alter function %s set search_path = public', f.sig);
    end loop;
end $$;

-- D. One posting per kiosk basket and product --------------------------------
-- Created only when no basket has already posted a product twice; if one has,
-- the index is skipped with a notice so the migration never fails halfway.
do $$
begin
    if exists (
        select 1 from public.stock_movements
         where source_doc_type = 'kiosk_scan' and source_doc_id is not null
         group by company_id, source_doc_id, product_id
        having count(*) > 1
    ) then
        raise notice 'uq_stock_movements_kiosk_session NOT created: some kiosk baskets already posted a product twice. Review them first.';
    else
        create unique index if not exists uq_stock_movements_kiosk_session
            on public.stock_movements (company_id, source_doc_id, product_id)
            where source_doc_type = 'kiosk_scan';
    end if;
end $$;
