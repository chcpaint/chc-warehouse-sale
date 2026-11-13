-- 067_scan_exceptions.sql
--
-- Scan issues: every scan that does not find an item is kept, with a reason,
-- so it can be put right straight after a count, a receiving run or a shift at
-- the kiosk -- and so nothing that was physically on the shelf is lost just
-- because its barcode did not scan.
--
-- One OPEN row per (company, location, scanned code): scanning the same code
-- again adds to `attempts` rather than making another row. `qty` is what the
-- person confirmed they were holding (1 unless they change it).
--
-- Written only by the server (service role). Row level security is on with no
-- policies, like every other table here, so the browser's anon key reads nothing.
--
-- Safe to run twice.

create table if not exists public.scan_exceptions (
    id                    uuid primary key default gen_random_uuid(),
    company_id            uuid not null references public.companies(id) on delete cascade,
    location_id           uuid references public.company_locations(id) on delete set null,
    code                  text not null,
    code_canonical        text not null,
    reason                text not null,
    context               text not null default 'scan',
    context_ref           text,
    intended_movement     text,
    suggested_product_id  uuid references public.products(id) on delete set null,
    suggested_library_id  uuid references public.item_library(id) on delete set null,
    suggested_label       text,
    attempts              integer not null default 1,
    qty                   numeric(12,3) not null default 1,
    note                  text,
    actor_label           text,
    first_seen_at         timestamptz not null default now(),
    last_seen_at          timestamptz not null default now(),
    status                text not null default 'open',
    resolution            text,
    resolved_product_id   uuid references public.products(id) on delete set null,
    stock_movement_id     uuid references public.stock_movements(id) on delete set null,
    resolved_by           uuid,
    resolved_by_label     text,
    resolved_at           timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),

    constraint scan_exceptions_code_len_chk      check (char_length(code) between 1 and 128),
    constraint scan_exceptions_reason_chk        check (reason in ('missing_barcode', 'not_in_catalog', 'inactive_item', 'unknown_code', 'invalid_code')),
    constraint scan_exceptions_context_chk       check (context in ('scan', 'receive', 'delivery', 'count', 'transfer', 'kiosk', 'other')),
    constraint scan_exceptions_intended_chk      check (intended_movement is null or intended_movement in ('receive', 'consume', 'count', 'none')),
    constraint scan_exceptions_qty_chk           check (qty > 0 and qty <= 100000),
    constraint scan_exceptions_attempts_chk      check (attempts >= 1),
    constraint scan_exceptions_note_len_chk      check (note is null or char_length(note) <= 300),
    constraint scan_exceptions_status_chk        check (status in ('open', 'resolved', 'dismissed')),
    constraint scan_exceptions_resolution_chk    check (resolution is null or resolution in
        ('barcode_added', 'added_to_catalogue', 'reactivated', 'scans_now', 'dismissed'))
);

comment on table public.scan_exceptions is
    'Scans that found no item (missing barcode, not in the catalogue, inactive, unknown or misread), kept with a reason until someone puts them right.';

-- One open row per shop location and code; resolved and dismissed rows are history.
create unique index if not exists scan_exceptions_open_uniq
    on public.scan_exceptions (company_id, location_id, code_canonical)
    where status = 'open';

create index if not exists scan_exceptions_company_status_idx
    on public.scan_exceptions (company_id, status, last_seen_at desc);

alter table public.scan_exceptions enable row level security;

-- Keep updated_at honest.
create or replace function public.scan_exceptions_touch()
returns trigger language plpgsql as $$
begin
    new.updated_at := now();
    return new;
end $$;

drop trigger if exists trg_scan_exceptions_touch on public.scan_exceptions;
create trigger trg_scan_exceptions_touch
    before update on public.scan_exceptions
    for each row execute function public.scan_exceptions_touch();
