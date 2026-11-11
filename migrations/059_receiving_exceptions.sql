-- ============================================================================
-- 059_receiving_exceptions.sql
--
-- Receiving against a CHC order already records what was scanned in, flags
-- extra items (unexpected_item) and over-receipts. This adds the other two
-- things that go wrong at the back door:
--
--   * DAMAGED: the box arrived but the item is not usable. It is recorded
--     against the order (so there is evidence for a credit or replacement) but
--     is NOT added to stock, and it still counts as owed on the order.
--   * SHORT: the driver has gone and the rest is not coming today. Closing the
--     delivery short records exactly which lines were outstanding, who closed
--     it and why, so "we were shorted" is a record and not an argument.
--
-- Nothing here changes how a normal receipt works. Safe to run more than once.
-- ============================================================================

alter table public.order_receipts
    add column if not exists exception_type text,
    add column if not exists exception_note text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'order_receipts_exception_chk'
    ) then
        alter table public.order_receipts
            add constraint order_receipts_exception_chk
            check (exception_type is null or exception_type in ('damaged'));
    end if;
end $$;

comment on column public.order_receipts.exception_type is
    'NULL for a normal receipt. ''damaged'' = arrived unusable: kept as evidence, never added to stock, still owed on the order.';

create table if not exists public.order_receiving_closures (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references public.companies(id) on delete cascade,
    order_id      uuid not null references public.orders(id) on delete cascade,
    location_id   uuid references public.company_locations(id) on delete set null,
    -- [{ product_id, sku, name, ordered, received, outstanding }]
    short_lines   jsonb not null default '[]'::jsonb,
    note          text,
    closed_by     text,
    created_at    timestamptz not null default now()
);

comment on table public.order_receiving_closures is
    'A delivery closed with items still outstanding. One row per closing; short_lines is the snapshot of what was owed at that moment.';

create unique index if not exists uq_order_receiving_closures_order
    on public.order_receiving_closures (order_id);
create index if not exists idx_order_receiving_closures_company
    on public.order_receiving_closures (company_id, created_at desc);

alter table public.order_receiving_closures enable row level security;
revoke all on public.order_receiving_closures from anon, authenticated;
