-- 055_followup_invoice.sql
--
-- A second ("follow-up") invoice for orders that shipped partially with a
-- backorder. Until now an order had exactly one invoice slot, so uploading the
-- invoice for the backordered items replaced the first one. These columns give
-- the order a second slot that works like the first: it shows as "Needs
-- Follow-up Invoice" until a file is uploaded, the customer can download it,
-- and the order cannot be closed while it is still owed.
--
-- followup_invoice_due   true once a partial shipment with backorder is recorded;
--                        stays true after the backorder ships (the "partial"
--                        flag is cleared then) until the follow-up is uploaded
--                        or staff say none is needed
-- followup_invoice_items what was short, copied when the partial shipment is
--                        recorded, so the reminder can still say what the
--                        follow-up invoice is for after backorder_items clears
-- followup_invoice_waived_* who said no follow-up invoice is needed, and why
--
-- Nothing here touches how any company signs in. Safe to re-run.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_due         boolean     NOT NULL DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_items       jsonb       NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_path        text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_filename    text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_uploaded_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_uploaded_by uuid REFERENCES public.admin_users(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_waived_at   timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_waived_by   uuid REFERENCES public.admin_users(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS followup_invoice_waived_note text;

-- Orders that are partially shipped right now already owe a follow-up invoice.
UPDATE public.orders
   SET followup_invoice_due   = true,
       followup_invoice_items = backorder_items
 WHERE is_partial_shipment = true
   AND followup_invoice_due = false
   AND followup_invoice_filename IS NULL
   AND status <> 'closed'
   AND status <> 'cancelled';

-- The console lists "orders that owe a follow-up invoice"; keep that cheap.
CREATE INDEX IF NOT EXISTS orders_followup_due_idx
    ON public.orders (company_id)
    WHERE followup_invoice_due AND followup_invoice_filename IS NULL;
