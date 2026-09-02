-- ============================================================================
-- 028_dashboard_and_job_export.sql
--
-- Two things, both about proving that what left the shelf matches what was
-- billed:
--
--   1. A defect fix. v_kit_billing does not filter repair_kits.is_active, so
--      every kit 026 retired still reports as "cannot bill". Nine dead rows
--      on a screen whose whole purpose is to say what is ready.
--
--   2. v_job_materials — one row per repair order per shop, costing what was
--      actually consumed against it. This is the artifact the collision
--      industry actually accepts for paint and materials: an itemised
--      invoice attached to the RO. There is no standard a distributor must
--      implement (CIECA EMS has been end-of-life since 2006; BMS is an
--      insurer/estimator message set, not a jobber feed), so the useful
--      output is a per-RO document the shop can attach to a supplement,
--      plus a CSV their office can import anywhere.
--
-- Safe to run more than once. No data is written; these are views only.
--
-- NOTE ON THE SUPABASE SQL EDITOR: it sends each statement on a pooled
-- connection with autocommit, so this file uses no temp tables and no
-- transaction control. Every statement stands alone on purpose.
-- ============================================================================

-- ------------------------------------------------------------
-- 1. v_kit_billing — same as 027 with one added predicate.
--
-- `k.is_active` was missing. A retired kit is still joined to
-- company_kit_access rows that were never cleaned up, so it kept appearing
-- in the readiness count as an unresolved kit nobody can fix. Filtering here
-- rather than deleting the access rows is deliberate: reactivating a kit
-- should restore its access exactly as it was.
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
      join public.repair_kits k  on k.id = a.kit_id
                                and k.company_id is null
                                and k.is_active            -- <- the fix
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
    round(coalesce(sum(qty * unit_price)
          filter (where not coalesce(is_excluded,false)
                    and mapped_product_id is not null), 0), 2) as billable_total,
    round(coalesce(sum(ref_line_total)
          filter (where not coalesce(is_excluded,false)), 0), 2) as reference_total,
    round(coalesce(sum(qty * unit_price)
          filter (where not coalesce(is_excluded,false)
                    and mapped_product_id is not null), 0)
        - coalesce(sum(ref_line_total)
          filter (where not coalesce(is_excluded,false)), 0), 2) as variance,
    (count(*) filter (where not coalesce(is_excluded,false)
                        and (mapped_product_id is null
                             or coalesce(unit_price,0) <= 0)) = 0) as is_billable
  from line
 group by company_id, kit_id, kit_name;

comment on view public.v_kit_billing is
    'Per company per ACTIVE master kit: what a consume would bill today, what the source system says it should be, and whether every line resolves. Retired kits are excluded (fixed in 028).';

-- ------------------------------------------------------------
-- 2. v_job_materials — the per-RO materials line, from the ledger.
--
-- Built on stock_movements rather than on kit_consumptions so it covers
-- everything drawn against a job: kit consumption AND anything scanned out
-- by hand. A shop that bills only what a kit expensed will under-bill.
--
-- value_billed EXCLUDES price-on-request items and items_unpriced counts
-- them, so the figure is a floor that says so, never a quiet shortfall.
-- ------------------------------------------------------------
create or replace view public.v_job_materials
with (security_invoker = true) as
select
    sm.company_id,
    c.name                                as company_name,
    sm.location_id,
    cl.name                               as location_name,
    sm.job_ref,
    min(sm.created_at)                    as first_used_at,
    max(sm.created_at)                    as last_used_at,
    count(*)                              as movement_count,
    count(distinct sm.product_id)         as distinct_items,
    sum(-sm.qty_change)                   as units_used,
    round(sum(case when p.price_on_request then 0
                   else (-sm.qty_change) * coalesce(p.price, 0) end), 2) as value_billed,
    count(distinct sm.product_id) filter (where p.price_on_request)      as items_unpriced,
    -- How much of this job came off a kit versus scanned by hand. A job that
    -- is entirely hand-scanned is fine; a job that is MOSTLY hand-scanned
    -- when a kit exists for that repair is worth a look.
    count(*) filter (where sm.source_doc_type = 'kit_consume')           as kit_movements,
    count(distinct sm.source_doc_id) filter (where sm.source_doc_type = 'kit_consume') as kits_used
  from public.stock_movements sm
  join public.products p           on p.id  = sm.product_id
  join public.company_locations cl on cl.id = sm.location_id
  join public.companies c          on c.id  = sm.company_id
 where sm.movement_type = 'consume'
   and sm.job_ref is not null
   and sm.job_ref <> ''
 group by sm.company_id, c.name, sm.location_id, cl.name, sm.job_ref;

comment on view public.v_job_materials is
    'Materials consumed per repair order, costed. The source for the per-RO materials invoice a shop attaches to a supplement. value_billed excludes price-on-request items; items_unpriced counts them.';

-- ------------------------------------------------------------
-- 3. Indexes for the dashboard reads.
--
-- The dashboard filters orders and kit_consumptions by company and date on
-- every load. Both are cheap today and will not stay cheap.
-- ------------------------------------------------------------
create index if not exists idx_orders_company_created
    on public.orders (company_id, created_at desc);

create index if not exists idx_kit_consumptions_company_created
    on public.kit_consumptions (company_id, created_at desc);

create index if not exists idx_stock_movements_job
    on public.stock_movements (company_id, job_ref)
    where job_ref is not null and movement_type = 'consume';
