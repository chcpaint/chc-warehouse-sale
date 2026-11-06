-- 054_kiosk_ordering.sql
--
-- Stock ordering from the scan-out kiosk. A manager taps "Place Stock Order",
-- enters the company's order passcode, scans items in the stock room and sends
-- the order. Staff use the kiosk to scan out and never get the passcode.
--
-- The passcode is stored only as a salted scrypt hash, in its own table, away
-- from companies.settings (which the storefront sends to the browser).
--
-- Nothing here touches how any company signs in to its store. Safe to re-run.
-- Run AFTER 053_scan_out_kiosk.sql.

-- ----------------------------------------------------------------------------
-- 1. The order passcode: one per company
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.kiosk_order_access (
    company_id    uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
    passcode_hash text NOT NULL,
    changed_at    timestamptz NOT NULL DEFAULT now(),
    changed_by    text
);

-- ----------------------------------------------------------------------------
-- 2. Brute-force lockout, per tablet. Five wrong passcodes lock that tablet's
--    order screen for a few minutes; a right one clears the count.
-- ----------------------------------------------------------------------------
ALTER TABLE public.kiosk_devices ADD COLUMN IF NOT EXISTS order_fail_count   integer NOT NULL DEFAULT 0;
ALTER TABLE public.kiosk_devices ADD COLUMN IF NOT EXISTS order_locked_until timestamptz;

-- ----------------------------------------------------------------------------
-- 3. Lock the table down. The server uses the service role (bypasses RLS).
-- ----------------------------------------------------------------------------
ALTER TABLE public.kiosk_order_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.kiosk_order_access FROM anon, authenticated;
