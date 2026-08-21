-- ============================================================================
-- 012_inventory_hardening.sql
-- CHC Console — Inventory module, phase 1-3 schema.
--
-- Migration 0xx (applied earlier) created the five foundation tables:
--   product_barcodes, inventory_levels, stock_movements,
--   replenishment_orders, replenishment_order_lines
--
-- This migration hardens that foundation for production use:
--   * actor identity on the ledger (storefront users are company+location
--     scoped, not admin_users, so created_by uuid alone cannot identify them)
--   * the link from an approved replenishment to the real CHC order
--   * a DB-side trigger that keeps inventory_levels.on_hand equal to the
--     running sum of the ledger, so on-hand can never drift from the audit trail
--   * integrity constraints, uniqueness and the indexes the module's queries need
--   * a master-file upload audit table
--
-- Idempotent: safe to run more than once, and safe to run whether or not the
-- foundation tables were already present.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Foundation tables (no-ops when they already exist)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_barcodes (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    barcode    text NOT NULL,
    symbology  text DEFAULT 'upc_a',
    is_primary boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_levels (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id  uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    product_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    on_hand      numeric NOT NULL DEFAULT 0,
    min_point    numeric,
    reorder_qty  numeric,
    max_point    numeric,
    bin_location text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (location_id, product_id)
);

CREATE TABLE IF NOT EXISTS public.stock_movements (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id     uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    qty_change      numeric NOT NULL,
    movement_type   text NOT NULL,
    reason          text,
    source_doc_type text,
    source_doc_id   uuid,
    scanned_barcode text,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.replenishment_orders (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    status      text NOT NULL DEFAULT 'draft',
    created_by  uuid,
    approved_by uuid,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.replenishment_order_lines (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id   uuid NOT NULL REFERENCES public.replenishment_orders(id) ON DELETE CASCADE,
    product_id uuid NOT NULL REFERENCES public.products(id),
    quantity   numeric NOT NULL DEFAULT 1,
    unit_price numeric,
    source     text DEFAULT 'manual'
);

-- ----------------------------------------------------------------------------
-- 1. stock_movements — actor identity, integrity, reporting indexes
-- ----------------------------------------------------------------------------

-- Storefront users authenticate with a company access code, so there is no
-- admin_users row to point created_by at. actor_type/actor_label record who
-- performed the movement in a way that works for both audiences.
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS actor_type  text;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS actor_label text;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS job_ref     text;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS on_hand_after numeric;

DO $$ BEGIN
    ALTER TABLE public.stock_movements
        ADD CONSTRAINT stock_movements_type_chk
        CHECK (movement_type IN ('receive','consume','adjust','count','transfer_in','transfer_out','seed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.stock_movements
        ADD CONSTRAINT stock_movements_qty_nonzero_chk CHECK (qty_change <> 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.stock_movements
        ADD CONSTRAINT stock_movements_actor_type_chk
        CHECK (actor_type IS NULL OR actor_type IN ('admin','store','system'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_stock_movements_company_time
    ON public.stock_movements (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_source_doc
    ON public.stock_movements (source_doc_type, source_doc_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_type_time
    ON public.stock_movements (company_id, movement_type, created_at DESC);

-- The ledger is append-only: a posted movement is never edited. A mistake is
-- corrected by posting an offsetting 'adjust' movement, which keeps both the
-- error and the correction visible to an auditor.
--
-- UPDATE only. DELETE is deliberately left open because products and companies
-- cascade-delete into this table, and the console hard-deletes products
-- (routes/admin.js products/bulk-delete). Blocking DELETE here would make
-- product deletion fail once a SKU had any movement history. Deletions of that
-- kind are deliberate admin actions and are already recorded in audit_log.
CREATE OR REPLACE FUNCTION public.stock_movements_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    RAISE EXCEPTION 'stock_movements is append-only; post a correcting "adjust" movement instead of editing row %', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS trg_stock_movements_append_only ON public.stock_movements;
CREATE TRIGGER trg_stock_movements_append_only
    BEFORE UPDATE ON public.stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.stock_movements_block_mutation();

-- ----------------------------------------------------------------------------
-- 2. inventory_levels — tracking flags, counting metadata
-- ----------------------------------------------------------------------------

ALTER TABLE public.inventory_levels ADD COLUMN IF NOT EXISTS is_tracked       boolean NOT NULL DEFAULT true;
ALTER TABLE public.inventory_levels ADD COLUMN IF NOT EXISTS last_counted_at  timestamptz;
ALTER TABLE public.inventory_levels ADD COLUMN IF NOT EXISTS last_movement_at timestamptz;
ALTER TABLE public.inventory_levels ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
    ALTER TABLE public.inventory_levels
        ADD CONSTRAINT inventory_levels_points_chk
        CHECK (
            (min_point   IS NULL OR min_point   >= 0) AND
            (max_point   IS NULL OR max_point   >= 0) AND
            (reorder_qty IS NULL OR reorder_qty >= 0) AND
            (min_point IS NULL OR max_point IS NULL OR max_point >= min_point)
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Low-stock scans hit this constantly; keep it cheap.
CREATE INDEX IF NOT EXISTS idx_inventory_levels_low_stock
    ON public.inventory_levels (company_id, location_id, on_hand)
    WHERE min_point IS NOT NULL AND is_tracked;
CREATE INDEX IF NOT EXISTS idx_inventory_levels_product
    ON public.inventory_levels (product_id);

-- ----------------------------------------------------------------------------
-- 3. product_barcodes — uniqueness and symbology integrity
-- ----------------------------------------------------------------------------

-- Collapse any duplicates left by earlier seeding before adding the constraint.
DELETE FROM public.product_barcodes a
      USING public.product_barcodes b
      WHERE a.product_id = b.product_id
        AND a.barcode    = b.barcode
        AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcodes_product_code
    ON public.product_barcodes (product_id, barcode);

ALTER TABLE public.product_barcodes ADD COLUMN IF NOT EXISTS label_printed_at timestamptz;
ALTER TABLE public.product_barcodes ADD COLUMN IF NOT EXISTS source           text;

DO $$ BEGIN
    ALTER TABLE public.product_barcodes
        ADD CONSTRAINT product_barcodes_symbology_chk
        CHECK (symbology IS NULL OR symbology IN ('upc_a','upc_e','ean_13','ean_8','code_128','code_39','qr_code','itf','other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.product_barcodes
        ADD CONSTRAINT product_barcodes_barcode_len_chk
        CHECK (char_length(barcode) BETWEEN 4 AND 128);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Only one primary barcode per product.
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_barcodes_primary
    ON public.product_barcodes (product_id) WHERE is_primary;

-- ----------------------------------------------------------------------------
-- 4. replenishment_orders — approval workflow + link to the real CHC order
-- ----------------------------------------------------------------------------

ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS order_id           uuid;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS submitted_at       timestamptz;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS approved_at        timestamptz;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS rejected_at        timestamptz;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS created_by_label   text;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS approved_by_label  text;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS decision_reason    text;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS po_number          text;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS contact_name       text;
ALTER TABLE public.replenishment_orders ADD COLUMN IF NOT EXISTS contact_email      text;

DO $$ BEGIN
    ALTER TABLE public.replenishment_orders
        ADD CONSTRAINT replenishment_orders_order_fk
        FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.replenishment_orders
        ADD CONSTRAINT replenishment_orders_status_chk
        CHECK (status IN ('draft','pending_approval','approved','rejected','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- At most one open (draft / pending) replenishment per location, so auto-drafted
-- lines accumulate into a single queue instead of spawning an order per scan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_replenishment_open_per_location
    ON public.replenishment_orders (location_id)
    WHERE status IN ('draft','pending_approval');

CREATE INDEX IF NOT EXISTS idx_replenishment_orders_time
    ON public.replenishment_orders (company_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. replenishment_order_lines — snapshots so the queue reads without joins
-- ----------------------------------------------------------------------------

ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS sku              text;
ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS name             text;
ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS on_hand_at_draft numeric;
ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS min_point        numeric;
ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS max_point        numeric;
ALTER TABLE public.replenishment_order_lines ADD COLUMN IF NOT EXISTS created_at       timestamptz NOT NULL DEFAULT now();

DO $$ BEGIN
    ALTER TABLE public.replenishment_order_lines
        ADD CONSTRAINT replenishment_order_lines_qty_chk CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The foundation created this FK without an ON DELETE action, so deleting a
-- product that appeared on any replenishment line would fail outright and take
-- the console's product bulk-delete with it. Match the cascade used everywhere
-- else in the module.
ALTER TABLE public.replenishment_order_lines
    DROP CONSTRAINT IF EXISTS replenishment_order_lines_product_id_fkey;
ALTER TABLE public.replenishment_order_lines
    ADD  CONSTRAINT replenishment_order_lines_product_id_fkey
    FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE;

DO $$ BEGIN
    ALTER TABLE public.replenishment_order_lines
        ADD CONSTRAINT replenishment_order_lines_source_chk
        CHECK (source IS NULL OR source IN ('manual','auto_min_point','auto_count'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One line per product per replenishment order — repeat triggers top up the
-- existing line rather than appending duplicates.
DELETE FROM public.replenishment_order_lines a
      USING public.replenishment_order_lines b
      WHERE a.order_id = b.order_id AND a.product_id = b.product_id AND a.id > b.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_replen_lines_order_product
    ON public.replenishment_order_lines (order_id, product_id);

CREATE INDEX IF NOT EXISTS idx_replen_lines_order
    ON public.replenishment_order_lines (order_id);

-- ----------------------------------------------------------------------------
-- 6. Master-file upload audit
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.inventory_uploads (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id   uuid REFERENCES public.company_locations(id) ON DELETE SET NULL,
    admin_id      uuid,
    filename      text,
    file_type     text,
    mode          text,               -- 'master' (catalog governance) | 'seed' (per-location stock)
    row_count     integer DEFAULT 0,
    products_new  integer DEFAULT 0,
    products_upd  integer DEFAULT 0,
    barcodes_new  integer DEFAULT 0,
    levels_seeded integer DEFAULT 0,
    status        text DEFAULT 'completed',
    error_details jsonb DEFAULT '[]'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_uploads_company
    ON public.inventory_uploads (company_id, created_at DESC);

ALTER TABLE public.inventory_uploads ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 7. On-hand is derived from the ledger, in the database
--
-- Every write path goes through stock_movements. This trigger keeps
-- inventory_levels.on_hand as the running sum inside the same transaction, so a
-- crashed request can never leave on-hand and the audit trail disagreeing.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_stock_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    new_on_hand numeric;
BEGIN
    INSERT INTO public.inventory_levels (company_id, location_id, product_id, on_hand, last_movement_at, updated_at)
    VALUES (NEW.company_id, NEW.location_id, NEW.product_id, NEW.qty_change, NEW.created_at, now())
    ON CONFLICT (location_id, product_id) DO UPDATE
        SET on_hand          = public.inventory_levels.on_hand + EXCLUDED.on_hand,
            last_movement_at = EXCLUDED.last_movement_at,
            last_counted_at  = CASE WHEN NEW.movement_type = 'count'
                                    THEN NEW.created_at
                                    ELSE public.inventory_levels.last_counted_at END,
            updated_at       = now()
    RETURNING on_hand INTO new_on_hand;

    NEW.on_hand_after := new_on_hand;
    RETURN NEW;
END;
$$;

-- BEFORE INSERT so on_hand_after can be stamped onto the ledger row itself,
-- giving every movement a self-contained "balance after" for auditors.
DROP TRIGGER IF EXISTS trg_apply_stock_movement ON public.stock_movements;
CREATE TRIGGER trg_apply_stock_movement
    BEFORE INSERT ON public.stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();

-- Repair / reconciliation: rebuild on-hand for one location (or the whole
-- company when p_location_id is NULL) straight from the ledger. Safe to run at
-- any time; returns the number of rows corrected.
CREATE OR REPLACE FUNCTION public.recompute_inventory_on_hand(
    p_company_id uuid,
    p_location_id uuid DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    fixed integer;
BEGIN
    WITH ledger AS (
        SELECT location_id, product_id, SUM(qty_change) AS total
          FROM public.stock_movements
         WHERE company_id = p_company_id
           AND (p_location_id IS NULL OR location_id = p_location_id)
         GROUP BY location_id, product_id
    ), corrected AS (
        UPDATE public.inventory_levels il
           SET on_hand = COALESCE(l.total, 0), updated_at = now()
          FROM ledger l
         WHERE il.location_id = l.location_id
           AND il.product_id  = l.product_id
           AND il.company_id  = p_company_id
           AND il.on_hand IS DISTINCT FROM COALESCE(l.total, 0)
        RETURNING 1
    )
    SELECT count(*) INTO fixed FROM corrected;
    RETURN fixed;
END;
$$;

-- These run only as triggers, from the service-role path in the Express layer.
-- Leaving them callable as /rest/v1/rpc/... by anon or authenticated serves no
-- purpose (the Supabase security advisor flags it, and rightly).
REVOKE ALL ON FUNCTION public.apply_stock_movement()           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_movements_block_mutation() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.recompute_inventory_on_hand(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recompute_inventory_on_hand(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.recompute_inventory_on_hand(uuid, uuid) FROM authenticated;

-- ----------------------------------------------------------------------------
-- 8. Row Level Security
--
-- The console reaches Postgres exclusively through the service-role key from
-- the Express layer, which authorises every request via requireCompanyAuth /
-- requireCompanyAccess. RLS stays ENABLED with no permissive policy, so the
-- anon and authenticated keys can read nothing here even if one leaks.
-- ----------------------------------------------------------------------------

ALTER TABLE public.product_barcodes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_levels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replenishment_orders       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.replenishment_order_lines  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.product_barcodes,
              public.inventory_levels,
              public.stock_movements,
              public.replenishment_orders,
              public.replenishment_order_lines,
              public.inventory_uploads
       FROM anon;

-- ----------------------------------------------------------------------------
-- 9. Reporting view — one row per tracked SKU per location with its status
-- ----------------------------------------------------------------------------

-- security_invoker keeps the view from becoming a way around the base tables'
-- RLS: it is readable only by roles that could read the tables themselves.
CREATE OR REPLACE VIEW public.inventory_status
WITH (security_invoker = true) AS
SELECT
    il.id,
    il.company_id,
    il.location_id,
    cl.name              AS location_name,
    il.product_id,
    p.sku,
    p.name               AS product_name,
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
        WHEN NOT il.is_tracked                            THEN 'untracked'
        WHEN il.on_hand <= 0                              THEN 'out'
        WHEN il.min_point IS NOT NULL
             AND il.on_hand <= il.min_point               THEN 'low'
        ELSE 'ok'
    END                  AS stock_status,
    GREATEST(COALESCE(il.max_point, il.min_point, 0) - il.on_hand, 0) AS suggested_order_qty
FROM public.inventory_levels il
JOIN public.products p          ON p.id  = il.product_id
JOIN public.company_locations cl ON cl.id = il.location_id;

REVOKE ALL ON public.inventory_status FROM anon;
REVOKE ALL ON public.inventory_status FROM authenticated;

COMMIT;
