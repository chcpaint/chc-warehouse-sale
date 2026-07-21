-- 010_location_province_restriction.sql
-- Per-location province + category restriction (e.g., Nova Scotia shops -> Equipment/Booth only).
ALTER TABLE public.company_locations ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE public.company_locations ADD COLUMN IF NOT EXISTS restrict_to_category text;
