-- ============================================================================
-- 032_order_receiving.sql
--
-- Receiving used to mean "scan things in" with no memory of why. A shop
-- placed an order with CHC, a truck showed up, and the only record of that
-- delivery was whatever generic 'receive' movements got scanned — nothing
-- tied them back to the order that caused them, so nobody could look at an
-- order and ask "did all of this actually arrive," or look at a movement and
-- ask "what was this for."
--
-- order_receipts is that missing link: one row per line actually scanned in
-- against an order, at whichever location received it. It is a ledger, the
-- same discipline as stock_movements itself -- "received 4, then corrected to
-- 3" is two rows, never one row edited, for the same reason a stock movement
-- is never edited. How much of an order has arrived is always the sum of
-- these rows, never a column on the order that could disagree with them.
--
-- A receipt is deliberately allowed against a line the order never had
-- (unexpected_item = true): a box sometimes contains more than the packing
-- slip says, and refusing to record that would just push the discrepancy
-- somewhere less visible than a flagged row here.
--
-- Safe to run more than once. No temp tables, no transaction control.
-- Checked with qa/migrations-smoke.sh.
-- ============================================================================

create table if not exists public.order_receipts (
    id                 uuid primary key default gen_random_uuid(),
    company_id         uuid not null references public.companies(id) on delete cascade,
    order_id           uuid not null references public.orders(id) on delete cascade,
    location_id        uuid not null references public.company_locations(id) on delete cascade,

    -- Nullable: a product can be deactivated or deleted years after it shipped,
    -- and the receipt must still say what arrived.
    product_id         uuid references public.products(id) on delete set null,

    -- Snapshots, same reasoning as orders.items and kit_consumptions.kit_name --
    -- a rename after the fact must not change what history says was received.
    sku                text,
    name               text,

    quantity_received  numeric not null,
    quantity_ordered   numeric,

    -- The order had no line for this product at all -- extra stock in the box,
    -- not a discrepancy on a line that was expected.
    unexpected_item    boolean not null default false,

    scanned_barcode    text,
    movement_id        uuid references public.stock_movements(id) on delete set null,

    actor_label        text,
    actor_type         text not null default 'store',
    created_at         timestamptz not null default now(),

    constraint order_receipts_qty_chk check (quantity_received <> 0),
    constraint order_receipts_actor_chk check (actor_type in ('admin', 'store', 'system'))
);

comment on table public.order_receipts is
    'One row per line scanned in against an order. "How much has arrived" is always the sum of these, never a column that could disagree with them.';
comment on column public.order_receipts.unexpected_item is
    'True when this product was not on the order at all -- extra stock in the box, recorded rather than dropped on the floor.';
comment on column public.order_receipts.movement_id is
    'The stock_movements row this receipt produced. NULL only if that movement was later deleted, which nothing in this app does.';

create index if not exists idx_order_receipts_order
    on public.order_receipts (order_id);
create index if not exists idx_order_receipts_company_location
    on public.order_receipts (company_id, location_id, created_at desc);

alter table public.order_receipts enable row level security;
revoke all on public.order_receipts from anon, authenticated;
