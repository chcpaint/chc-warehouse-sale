-- 035_order_tax.sql
--
-- Orders already had a `tax` column (migration 001) but nothing ever wrote to
-- it -- every order's tax defaulted to 0, so an order's total and CHC's own
-- invoice for that order disagreed by exactly the tax amount, every time.
--
-- This adds `tax_rate`: the rate actually applied to a given order, stored
-- alongside the `tax` amount it produced. It exists for the same reason
-- purchase-order numbers are never recomputed after the fact (migration 019)
-- -- if a company's tax rate or exemption changes later, an already-placed
-- order must keep showing the rate it was actually charged, not silently
-- reprice itself against today's settings. `tax` alone (a dollar amount)
-- cannot answer "what rate was this?" on its own; `tax_rate` can.
--
-- The rate itself is resolved per company from `companies.settings->'tax'`
-- (see utils/tax.js) rather than a new column on companies, following the
-- same pattern purchase-order settings already use in `settings->'purchase_orders'`.
-- Nothing here changes existing behaviour until an order is placed after this
-- migration runs: past orders keep tax = 0, which is what they were actually
-- charged before this feature existed.
--
-- Safe to re-run.

begin;

alter table public.orders add column if not exists tax_rate numeric(6,4);

comment on column public.orders.tax_rate is
  'The tax rate applied to this order at the time it was placed (e.g. 0.13 for 13% HST). Null on orders placed before this column existed. Historical -- never recomputed after the fact.';

commit;
