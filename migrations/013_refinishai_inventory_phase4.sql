-- ============================================================================
-- 013_refinishai_inventory_phase4.sql
-- refinishAI Inventory — phase 4.
--
--   * cycle-count sessions as a first-class workflow
--   * inter-location transfers
--   * internal label registry (items with no manufacturer UPC)
--   * master-catalog governance bookkeeping
--
-- Applied to the CHC Sale Site project as migration
-- `refinishai_inventory_phase4_counts_transfers_labels`. Kept here so the repo
-- history matches the database. Idempotent.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Cycle counts
--
-- A count is a session, not a single movement: staff count a bin or a category
-- over minutes or hours, then a supervisor reviews the variances and commits.
-- Only the commit writes to the ledger, so a half-finished count never moves
-- stock and an abandoned one leaves no trace.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_count_sessions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    location_id    uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    name           text,
    scope_type     text DEFAULT 'all',      -- all | category | bin | selection
    scope_value    text,
    status         text NOT NULL DEFAULT 'open',   -- open | committed | cancelled
    opened_by      text,
    committed_by   text,
    notes          text,
    line_count     integer DEFAULT 0,
    variance_count integer DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now(),
    committed_at   timestamptz,
    cancelled_at   timestamptz
);

DO $$ BEGIN
    ALTER TABLE public.inventory_count_sessions ADD CONSTRAINT inventory_count_status_chk
        CHECK (status IN ('open','committed','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.inventory_count_sessions ADD CONSTRAINT inventory_count_scope_chk
        CHECK (scope_type IN ('all','category','bin','selection'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One open count per location: two people counting the same shelf into
-- different sessions would each commit a variance against a moving target.
CREATE UNIQUE INDEX IF NOT EXISTS uq_open_count_per_location
    ON public.inventory_count_sessions (location_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_count_sessions_company
    ON public.inventory_count_sessions (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.inventory_count_lines (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      uuid NOT NULL REFERENCES public.inventory_count_sessions(id) ON DELETE CASCADE,
    product_id      uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    sku             text,
    name            text,
    counted_qty     numeric NOT NULL,
    expected_qty    numeric,      -- on-hand at the moment it was counted
    variance        numeric,      -- counted - expected, frozen at count time
    counted_by      text,
    scanned_barcode text,
    note            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE public.inventory_count_lines ADD CONSTRAINT inventory_count_lines_qty_chk
        CHECK (counted_qty >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Re-counting an item replaces its line rather than adding a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_count_line_session_product
    ON public.inventory_count_lines (session_id, product_id);
CREATE INDEX IF NOT EXISTS idx_count_lines_session ON public.inventory_count_lines (session_id);

-- ---------------------------------------------------------------------------
-- Inter-location transfers
--
-- A transfer is two ledger rows that must agree. The header records the pair so
-- a stock controller sees them as one event rather than as an unexplained loss
-- at one shop and an unexplained gain at another.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory_transfers (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    from_location_id uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    to_location_id   uuid NOT NULL REFERENCES public.company_locations(id) ON DELETE CASCADE,
    product_id       uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    quantity         numeric NOT NULL,
    reason           text,
    actor_label      text,
    out_movement_id  uuid,
    in_movement_id   uuid,
    created_at       timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
    ALTER TABLE public.inventory_transfers ADD CONSTRAINT inventory_transfers_qty_chk CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE public.inventory_transfers ADD CONSTRAINT inventory_transfers_distinct_chk
        CHECK (from_location_id <> to_location_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_transfers_company ON public.inventory_transfers (company_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Master-catalog governance + internal labels
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory_uploads ADD COLUMN IF NOT EXISTS products_deactivated integer DEFAULT 0;
ALTER TABLE public.inventory_uploads ADD COLUMN IF NOT EXISTS governed boolean DEFAULT false;

ALTER TABLE public.product_barcodes ADD COLUMN IF NOT EXISTS is_internal boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_product_barcodes_internal
    ON public.product_barcodes (product_id) WHERE is_internal;

-- Lockdown, consistent with the phase 1-3 tables: RLS on, no policy, so only
-- the service role reaches them.
ALTER TABLE public.inventory_count_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_lines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_transfers      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.inventory_count_sessions,
              public.inventory_count_lines,
              public.inventory_transfers
       FROM anon;

COMMIT;
