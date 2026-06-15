-- 005_harden_rls.sql
-- Remove permissive public RLS policies. The app uses the service-role client only
-- (bypasses RLS) and does not use Supabase Auth, so these grant nothing the app needs
-- but would expose data to the anon key. Dropping them denies anon/authenticated.
DROP POLICY IF EXISTS "Service role full access" ON public.catalog_tokens;
DROP POLICY IF EXISTS companies_select ON public.companies;       -- exposed access-code hashes
DROP POLICY IF EXISTS orders_insert    ON public.orders;          -- anon could insert orders
DROP POLICY IF EXISTS products_select  ON public.products;        -- anon catalog read (unused)
DROP POLICY IF EXISTS promotions_select ON public.promotions;     -- anon promo read (unused)
