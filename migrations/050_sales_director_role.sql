-- 050_sales_director_role.sql
--
-- A "sales_director" staff role: sees every customer of their distributor,
-- adds/edits items in a customer's catalog, views and adjusts customer pricing,
-- and works orders. It cannot create or edit companies, locations or users, and
-- cannot reach tax, modules, billing, fees, branding or the master table. What
-- it may reach is the allow-list in middleware/auth.js (SALES_DIRECTOR_EXTRA).
--
-- admin_users carries a valid_role CHECK, so the role has to be admitted here
-- before any account can hold it. Idempotent: safe to run twice.

alter table public.admin_users drop constraint if exists valid_role;
alter table public.admin_users add constraint valid_role
    check ((role)::text = any (array[
        'platform_admin', 'super_admin', 'company_admin', 'admin',
        'order_desk', 'order_manager', 'sales_director'
    ]::text[]));
