-- 043_shared_cart.sql
--
-- The storefront cart lived only in the browser's sessionStorage, one copy
-- per browser tab. Two people signed in to the same customer account --
-- the normal way one shop shares an order, e.g. a rep builds it and the
-- owner reviews and submits it -- got two completely disconnected carts,
-- with no way for either of them to see what the other had put in. Whoever
-- built the cart had to be the one who checked out, which is exactly the
-- bug a customer reported: one person's cart was full, the other person's
-- was empty, on the same account.
--
-- This makes the cart what everyone already assumed it was: one shared
-- cart per customer account (company_id), visible and editable by anyone
-- signed in to that account, whether through the shared company login or
-- an individual company_user login (both resolve to req.company.id in
-- requireCompanyAuth -- see middleware/auth.js).
--
-- Only product_id and quantity are kept here. Price is deliberately NOT
-- stored: routes/storefront.js already re-prices every line from the
-- server at checkout time (products + promotions, never trusting the
-- client), and the storefront's own cart preview re-derives price the same
-- way from data it already has loaded. A cached price on this table would
-- just be one more place for it to go stale.

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  quantity integer not null default 1 check (quantity > 0 and quantity <= 9999),
  added_by_user_id uuid references public.company_users(id) on delete set null,
  added_by_name varchar(255),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One line per product per account. "Add to cart" again bumps the quantity
-- on the existing row instead of creating a second one.
create unique index if not exists uq_cart_items_company_product
  on public.cart_items(company_id, product_id);
create index if not exists idx_cart_items_company on public.cart_items(company_id);

-- Same "service-role only" pattern as every other table in this schema --
-- the app only ever reaches this table through the Express API's
-- service-role client.
alter table public.cart_items enable row level security;
