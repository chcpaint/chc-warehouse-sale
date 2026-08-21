-- ============================================================================
-- 014_refinishai_inventory_phase5.sql
-- refinishAI Inventory — phase 5: consumption analytics and alert bookkeeping.
--
-- The ledger already holds everything the analytics need; these are read paths
-- over it, defined in the database so the API stays thin and the aggregation
-- happens where the rows are.
--
-- Applied as `refinishai_inventory_phase5_consumption_analytics`, plus
-- `refinishai_inventory_harden_trigger_functions`. Idempotent.
-- ============================================================================

BEGIN;

-- Daily consumption per product per location, valued at the current catalogue
-- price. Consumption is stored as a negative qty_change, so it is negated here
-- to give a positive "units used".
CREATE OR REPLACE VIEW public.inventory_consumption_daily
WITH (security_invoker = true) AS
SELECT
    sm.company_id,
    sm.location_id,
    cl.name                          AS location_name,
    sm.product_id,
    p.sku,
    p.name                           AS product_name,
    p.brand,
    p.category,
    date_trunc('day', sm.created_at) AS day,
    SUM(-sm.qty_change)              AS units_used,
    SUM(-sm.qty_change * COALESCE(p.price, 0)) AS value_used,
    COUNT(*)                         AS movement_count
FROM public.stock_movements sm
JOIN public.products p           ON p.id  = sm.product_id
JOIN public.company_locations cl ON cl.id = sm.location_id
WHERE sm.movement_type = 'consume'
GROUP BY sm.company_id, sm.location_id, cl.name, sm.product_id,
         p.sku, p.name, p.brand, p.category, date_trunc('day', sm.created_at);

REVOKE ALL ON public.inventory_consumption_daily FROM anon;
REVOKE ALL ON public.inventory_consumption_daily FROM authenticated;

-- Consumption grouped by the job / RO number a technician entered at scan time.
-- This is what turns inventory data into a materials cost per repair order.
CREATE OR REPLACE VIEW public.inventory_consumption_by_job
WITH (security_invoker = true) AS
SELECT
    sm.company_id,
    sm.location_id,
    cl.name                       AS location_name,
    sm.job_ref,
    MIN(sm.created_at)            AS first_used_at,
    MAX(sm.created_at)            AS last_used_at,
    COUNT(DISTINCT sm.product_id) AS distinct_items,
    SUM(-sm.qty_change)           AS units_used,
    SUM(-sm.qty_change * COALESCE(p.price, 0)) AS value_used
FROM public.stock_movements sm
JOIN public.products p           ON p.id  = sm.product_id
JOIN public.company_locations cl ON cl.id = sm.location_id
WHERE sm.movement_type = 'consume'
  AND sm.job_ref IS NOT NULL
  AND sm.job_ref <> ''
GROUP BY sm.company_id, sm.location_id, cl.name, sm.job_ref;

REVOKE ALL ON public.inventory_consumption_by_job FROM anon;
REVOKE ALL ON public.inventory_consumption_by_job FROM authenticated;

-- The aggregations the dashboards run constantly.
CREATE INDEX IF NOT EXISTS idx_stock_movements_consume_day
    ON public.stock_movements (company_id, location_id, created_at DESC)
    WHERE movement_type = 'consume';

CREATE INDEX IF NOT EXISTS idx_stock_movements_job_ref
    ON public.stock_movements (company_id, job_ref)
    WHERE job_ref IS NOT NULL AND job_ref <> '';

-- Records each low-stock digest, so a nightly job can be re-run safely and
-- nobody receives the same list twice.
CREATE TABLE IF NOT EXISTS public.inventory_alert_log (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id uuid REFERENCES public.company_locations(id) ON DELETE SET NULL,
    alert_type  text NOT NULL DEFAULT 'low_stock',
    item_count  integer DEFAULT 0,
    recipients  text[] DEFAULT '{}',
    fingerprint text,
    sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_alert_log_company
    ON public.inventory_alert_log (company_id, alert_type, sent_at DESC);

ALTER TABLE public.inventory_alert_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_alert_log FROM anon;

-- ---------------------------------------------------------------------------
-- Advisor follow-ups on the phase 1-3 trigger functions.
-- ---------------------------------------------------------------------------

-- Pin the search_path so the function cannot be steered at another schema.
CREATE OR REPLACE FUNCTION public.stock_movements_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    RAISE EXCEPTION 'stock_movements is append-only; post a correcting "adjust" movement instead of editing row %', OLD.id;
END;
$$;

-- These run only as triggers, from the service-role path in the Express layer.
-- Leaving them callable as /rest/v1/rpc/... by anon or authenticated serves no
-- purpose, and the Supabase security advisor flags it.
REVOKE ALL ON FUNCTION public.apply_stock_movement()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_movements_block_mutation() FROM PUBLIC, anon, authenticated;

COMMIT;
