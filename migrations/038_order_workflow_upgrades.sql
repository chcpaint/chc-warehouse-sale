-- Order-workflow upgrades requested after the CHC staff feedback meeting:
--
--   1. A simplified, per-distributor order-status set. CHC wants exactly
--      Received -> Out for Delivery -> (optionally) Partial Shipment with
--      Backorder -> Closed; other distributors keep the fuller set
--      (pending/processing/out_on_delivery/closed/cancelled) untouched.
--      "Partial Shipment with Backorder" is not a new status value -- it is
--      the existing `out_on_delivery` status plus a flag, so a partially
--      shipped order still sorts, filters and reports as "out on delivery"
--      everywhere that already works. See utils/order-status.js.
--   2. Staff price/line edits on an already-placed order -- who touched it,
--      when, and why.
--   3. A running notes/messages log per order (customer requests for
--      pricing on non-catalog items, a return to be picked up, etc.),
--      separate from the original checkout `notes` field so a conversation
--      can continue after submission without overwriting the original note.
--
-- Nothing here changes existing behaviour by itself: every new column
-- defaults to a value that reproduces exactly what happens today
-- (is_partial_shipment=false, notes_log=[]), and CHC is opted into the
-- simplified status set explicitly below rather than by a code default, so
-- a future distributor is on the full set unless someone chooses otherwise
-- for them too.

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS is_partial_shipment boolean NOT NULL DEFAULT false;

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS notes_log jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS price_edited_at timestamptz;

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS price_edited_by uuid REFERENCES public.admin_users(id) ON DELETE SET NULL;

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS price_edit_reason text;

-- CHC opts into the simplified status set. `settings` already defaults to
-- '{}' for every distributor, so this merges the one key in rather than
-- overwriting anything else that may already be set there.
UPDATE public.distributors
SET settings = settings || '{"order_status_mode": "simplified"}'::jsonb
WHERE id = '4d763514-3a41-45f2-b31d-e38756ba1595';
