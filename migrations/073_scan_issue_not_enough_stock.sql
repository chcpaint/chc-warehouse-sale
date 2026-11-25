-- ============================================================================
-- 073: Scan issues -- "Not enough on hand"
--
-- A scan-out that is refused because the count shows too few on hand (and the
-- shop does not allow stock below zero) is now kept in Scan issues, like a scan
-- that found no item. The goods were physically there, so the count is out and
-- a manager needs to see it. This only widens the allowed reasons; no data
-- changes. Safe to run twice.
-- ============================================================================
ALTER TABLE public.scan_exceptions DROP CONSTRAINT IF EXISTS scan_exceptions_reason_chk;
ALTER TABLE public.scan_exceptions ADD CONSTRAINT scan_exceptions_reason_chk
    CHECK (reason IN ('missing_barcode', 'not_in_catalog', 'inactive_item', 'unknown_code', 'invalid_code', 'not_enough_stock'));

NOTIFY pgrst, 'reload schema';
