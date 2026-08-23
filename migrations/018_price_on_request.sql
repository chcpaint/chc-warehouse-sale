-- ============================================================
-- 018 — "Contact for current pricing"
--
-- Applied to the CHC Sale Site project on 2026-08-22 as 20260822223352.
--
-- 52 active products in the live catalogue carried a price of $0.00. Much of it
-- is deliberate — equipment, tools and mixed paint that a branch prices at the
-- moment of purchase, once it has a true cost — but $0.00 is a terrible way to
-- say so. It is indistinguishable from free, and it is silently wrong wherever
-- it lands:
--
--   * the storefront shows "$0.00" against a real product
--   * an order totals it at nothing, so the branch gets no prompt to price it
--   * job costing counts the material as free, understating what a repair cost
--   * stock value counts the shelf as worth nothing
--
-- The last two matter most. A shop's whole reason for using this module is to
-- learn what a job consumed; a line that quietly reports $0 does not merely
-- fail to help, it makes the total wrong in a way nobody can see from the
-- screen. On the seeded CHC Test data, 39 of 185 repair orders were affected.
--
-- So this is a state, not a label. `price_on_request` is explicit, survives a
-- reference price later being entered, and — the point — lets every total
-- EXCLUDE the item and report how many it excluded, rather than adding zero
-- and saying nothing.
--
-- NOTE ON THE VIEWS: the new columns are APPENDED, never inserted. CREATE OR
-- REPLACE VIEW refuses to reorder or rename existing columns, and appending
-- also means anything reading these views positionally is unaffected.
-- ============================================================

alter table public.products
    add column if not exists price_on_request boolean not null default false;

comment on column public.products.price_on_request is
    'True = the branch quotes this at the moment of purchase. The storefront shows "Contact for current pricing", orders flag it for pricing, and every cost or value total excludes it and reports the exclusion rather than counting it as zero.';

create index if not exists idx_products_price_on_request
    on public.products(company_id) where price_on_request;

-- Adopt the existing zero-priced items. Scoped to price = 0 exactly: turning a
-- priced item into a quoted one is a commercial decision, not a data fix.
update public.products
   set price_on_request = true
 where coalesce(price, 0) = 0
   and price_on_request = false;

-- ------------------------------------------------------------
-- inventory_status — stock value must not count a quoted item as worthless.
-- `price` is still exposed unchanged so nothing reading it breaks.
-- ------------------------------------------------------------
create or replace view public.inventory_status
with (security_invoker = true) as
 SELECT il.id,
    il.company_id,
    il.location_id,
    cl.name AS location_name,
    il.product_id,
    p.sku,
    p.name AS product_name,
    p.brand,
    p.category,
    p.price,
    p.case_qty,
    p.unit,
    il.on_hand,
    il.min_point,
    il.reorder_qty,
    il.max_point,
    il.bin_location,
    il.is_tracked,
    il.last_counted_at,
    il.last_movement_at,
        CASE
            WHEN NOT il.is_tracked THEN 'untracked'::text
            WHEN il.on_hand <= 0::numeric THEN 'out'::text
            WHEN il.min_point IS NOT NULL AND il.on_hand <= il.min_point THEN 'low'::text
            ELSE 'ok'::text
        END AS stock_status,
    GREATEST(COALESCE(il.max_point, il.min_point, 0::numeric) - il.on_hand, 0::numeric) AS suggested_order_qty,
    p.price_on_request,
    -- The value of this line, or NULL when it cannot honestly be valued.
    -- NULL rather than 0 so SUM() skips it and COUNT() can still find it.
    CASE WHEN p.price_on_request THEN NULL
         ELSE il.on_hand * COALESCE(p.price, 0::numeric)
    END AS line_value
   FROM inventory_levels il
     JOIN products p ON p.id = il.product_id
     JOIN company_locations cl ON cl.id = il.location_id;

-- ------------------------------------------------------------
-- Consumption views — the same principle for job costing. `value_used` now
-- excludes quoted items; the new columns say how much was excluded, so a job
-- reports its real cost plus "N items priced on request" rather than a smaller
-- number that looks complete.
-- ------------------------------------------------------------
create or replace view public.inventory_consumption_daily
with (security_invoker = true) as
 SELECT sm.company_id,
    sm.location_id,
    cl.name AS location_name,
    sm.product_id,
    p.sku,
    p.name AS product_name,
    p.brand,
    p.category,
    date_trunc('day'::text, sm.created_at) AS day,
    sum(- sm.qty_change) AS units_used,
    sum(CASE WHEN p.price_on_request THEN 0::numeric
             ELSE (- sm.qty_change) * COALESCE(p.price, 0::numeric) END) AS value_used,
    count(*) AS movement_count,
    p.price_on_request,
    sum(CASE WHEN p.price_on_request THEN - sm.qty_change ELSE 0::numeric END) AS units_unpriced
   FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     JOIN company_locations cl ON cl.id = sm.location_id
  WHERE sm.movement_type = 'consume'::text
  GROUP BY sm.company_id, sm.location_id, cl.name, sm.product_id, p.sku, p.name,
           p.brand, p.category, p.price_on_request, (date_trunc('day'::text, sm.created_at));

create or replace view public.inventory_consumption_by_job
with (security_invoker = true) as
 SELECT sm.company_id,
    sm.location_id,
    cl.name AS location_name,
    sm.job_ref,
    min(sm.created_at) AS first_used_at,
    max(sm.created_at) AS last_used_at,
    count(DISTINCT sm.product_id) AS distinct_items,
    sum(- sm.qty_change) AS units_used,
    sum(CASE WHEN p.price_on_request THEN 0::numeric
             ELSE (- sm.qty_change) * COALESCE(p.price, 0::numeric) END) AS value_used,
    -- DISTINCT items on this job that could not be costed. This is the number
    -- shown beside the total, so a manager knows the figure is a floor.
    count(DISTINCT sm.product_id) FILTER (WHERE p.price_on_request) AS items_unpriced
   FROM stock_movements sm
     JOIN products p ON p.id = sm.product_id
     JOIN company_locations cl ON cl.id = sm.location_id
  WHERE sm.movement_type = 'consume'::text AND sm.job_ref IS NOT NULL AND sm.job_ref <> ''::text
  GROUP BY sm.company_id, sm.location_id, cl.name, sm.job_ref;

comment on view public.inventory_consumption_by_job is
    'Materials per repair order. value_used EXCLUDES price-on-request items; items_unpriced counts them, so the total is never quietly short.';
