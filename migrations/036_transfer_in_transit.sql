-- ============================================================================
-- 036_transfer_in_transit.sql
--
-- Inter-location transfers become a two-phase move instead of one atomic
-- step. Until now performOneTransfer() wrote both stock_movements legs in the
-- same request, so a transfer had no real-world transit time: stock left one
-- shelf and landed on another in the same second, and nothing recorded who
-- was carrying it in between.
--
-- Requested change: shipping a line now writes only the outbound leg and
-- parks the transfer in 'in_transit' status with a driver attached; the
-- destination only gains the stock, and the row only closes out, once someone
-- there scans it in. That gives shops, stores and drivers a real answer to
-- "where is this and who has it" for whatever is between the two locations.
--
-- inventory_drivers is a lightweight named roster per company -- the same
-- no-login, just-a-name pattern already used for actor_label everywhere else
-- in this app. A driver is someone accountable for a truck, not a system
-- user, so this deliberately does not reuse company_users (which is gated
-- behind the Customer-users module and requires an email/invite).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.inventory_drivers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name        text NOT NULL,
    phone       text,
    is_active   boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_drivers_company ON public.inventory_drivers (company_id, is_active);

ALTER TABLE public.inventory_drivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_drivers FROM anon;

-- ---------------------------------------------------------------------------
-- inventory_transfers gains a lifecycle. actor_label already records who
-- performed the shipping scan, so it is kept as "shipped by" rather than
-- duplicated under a new name.
--
-- Every row that predates this migration was written by the old one-step
-- performOneTransfer() and already carries both legs (in_movement_id is set)
-- -- in effect, already received on arrival. The default below lands new
-- columns as 'in_transit' first; the backfill directly after corrects every
-- pre-existing, already-completed row to 'received' so history keeps reading
-- the way it always has.
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventory_transfers
    ADD COLUMN IF NOT EXISTS status            varchar(16) NOT NULL DEFAULT 'in_transit',
    ADD COLUMN IF NOT EXISTS driver_id         uuid REFERENCES public.inventory_drivers(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS driver_name       text,
    ADD COLUMN IF NOT EXISTS received_at       timestamptz,
    ADD COLUMN IF NOT EXISTS received_by       text,
    ADD COLUMN IF NOT EXISTS quantity_received numeric,
    ADD COLUMN IF NOT EXISTS cancelled_at      timestamptz,
    ADD COLUMN IF NOT EXISTS cancelled_by      text;

DO $$ BEGIN
    ALTER TABLE public.inventory_transfers ADD CONSTRAINT inventory_transfers_status_chk
        CHECK (status IN ('in_transit', 'received', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE public.inventory_transfers
SET status = 'received',
    quantity_received = quantity,
    received_at = created_at,
    received_by = actor_label
WHERE in_movement_id IS NOT NULL AND received_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_transfers_to_status   ON public.inventory_transfers (company_id, to_location_id, status);
CREATE INDEX IF NOT EXISTS idx_transfers_from_status ON public.inventory_transfers (company_id, from_location_id, status);
