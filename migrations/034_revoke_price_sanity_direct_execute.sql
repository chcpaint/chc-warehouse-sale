-- 034_revoke_price_sanity_direct_execute.sql
--
-- products_price_sanity() is a BEFORE INSERT/UPDATE trigger on products (see
-- migration 024). It has no business being callable directly over
-- PostgREST's RPC endpoint -- Supabase's security advisor flags it as a
-- SECURITY DEFINER function the anon and authenticated roles can execute via
-- POST /rest/v1/rpc/products_price_sanity.
--
-- Revoking direct EXECUTE closes that path while leaving the trigger itself
-- untouched: a trigger fires under the table owner's privileges regardless
-- of what grants exist on the function for other roles.
--
-- Safe to re-run.

begin;

revoke execute on function public.products_price_sanity() from public;
revoke execute on function public.products_price_sanity() from anon;
revoke execute on function public.products_price_sanity() from authenticated;

commit;
