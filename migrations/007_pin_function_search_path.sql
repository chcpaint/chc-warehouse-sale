-- 007_pin_function_search_path.sql
-- Pin a stable search_path on functions (resolves function_search_path_mutable lint).
ALTER FUNCTION public.generate_order_number() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.update_updated_at_column() SET search_path = public, pg_temp;
ALTER FUNCTION public.generate_catalog_token(character varying, character varying, integer, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.validate_and_use_token(character varying, character varying) SET search_path = public, pg_temp;
