-- 070_count_by_manufacturer.sql
--
-- A count can now cover one manufacturer (brand, e.g. "PPG" or "3M") or one
-- PPG paint line (e.g. "Envirobase / EHP"), picked from a list of what the
-- shop actually carries, instead of a category typed by hand.
--
-- Only widens the allowed values of inventory_count_sessions.scope_type.
-- Nothing else changes. Safe to run twice.

alter table public.inventory_count_sessions drop constraint if exists inventory_count_scope_chk;
alter table public.inventory_count_sessions
    add constraint inventory_count_scope_chk
    check (scope_type in ('all', 'brand', 'line', 'category', 'bin', 'selection'));
