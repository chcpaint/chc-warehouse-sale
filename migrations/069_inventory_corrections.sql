-- 069_inventory_corrections.sql
--
-- Corrections to a finished count or a posted delivery, made by a manager or
-- admin in the console when staff got a number wrong.
--
-- Nothing already posted is edited or deleted. A correction posts one new
-- 'adjust' movement for the difference (the ledger stays append-only), and is
-- recorded here with the number before and after, why, and who made it:
--
--   kind = 'count'    a line of a committed count: counted 12, should have been 10
--   kind = 'receipt'  a delivery: 6 were received against the order, really 4
--
-- A receipt correction also adds an order_receipts row for the difference
-- (exception_type 'correction'), so "received so far" on the order is right.
--
-- Safe to run twice.

create table if not exists public.inventory_corrections (
    id                uuid primary key default gen_random_uuid(),
    company_id        uuid not null references public.companies(id) on delete cascade,
    location_id       uuid not null references public.company_locations(id) on delete cascade,
    kind              text not null,
    count_session_id  uuid references public.inventory_count_sessions(id) on delete set null,
    count_line_id     uuid references public.inventory_count_lines(id) on delete set null,
    order_id          uuid references public.orders(id) on delete set null,
    product_id        uuid references public.products(id) on delete set null,
    sku               text,
    name              text,
    old_qty           numeric not null,
    new_qty           numeric not null,
    qty_change        numeric not null,
    movement_id       uuid references public.stock_movements(id) on delete set null,
    reason            text not null,
    actor_type        text not null default 'admin',
    actor_label       text,
    admin_id          uuid,
    created_at        timestamptz not null default now(),
    constraint inventory_corrections_kind_chk check (kind in ('count', 'receipt')),
    constraint inventory_corrections_change_chk check (qty_change <> 0),
    constraint inventory_corrections_actor_chk check (actor_type in ('admin', 'store', 'system'))
);

comment on table public.inventory_corrections is
    'A manager or admin putting right a committed count line or a posted delivery. Each one posted an adjust movement (movement_id) for qty_change.';

create index if not exists idx_inventory_corrections_session
    on public.inventory_corrections (count_session_id) where count_session_id is not null;
create index if not exists idx_inventory_corrections_order
    on public.inventory_corrections (order_id) where order_id is not null;
create index if not exists idx_inventory_corrections_company
    on public.inventory_corrections (company_id, created_at desc);

alter table public.inventory_corrections enable row level security;
revoke all on public.inventory_corrections from anon, authenticated;

-- A delivery correction is an order_receipts row too.
alter table public.order_receipts drop constraint if exists order_receipts_exception_chk;
alter table public.order_receipts
    add constraint order_receipts_exception_chk
    check (exception_type is null or exception_type in ('damaged', 'correction'));
