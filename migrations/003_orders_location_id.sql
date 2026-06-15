-- 003_orders_location_id.sql
-- Adds a real foreign-key link from orders to company_locations so per-location
-- reporting is reliable (the previous free-text orders.location stays for display).
-- Additive and non-destructive: location_id is nullable; old orders are backfilled
-- by matching their text label to a location name.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS location_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'orders_location_id_fkey'
      AND table_name = 'orders'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES public.company_locations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_location_id ON public.orders(location_id);

-- Backfill existing orders from their text label where it matches a real location
UPDATE public.orders o
SET location_id = cl.id
FROM public.company_locations cl
WHERE cl.company_id = o.company_id
  AND lower(trim(cl.name)) = lower(trim(o.location))
  AND o.location_id IS NULL;
