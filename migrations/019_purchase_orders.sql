-- ============================================================
-- 019 — Purchase orders: off, the shop's own, or issued by us
--
-- Today `po_number` is free text and MANDATORY for every company. That
-- combination is the whole problem: a shop with no purchase-order system still
-- has to put something in the box, so it puts the same thing in every time.
-- The live data shows it — `123456` on five orders across two companies, with
-- nothing to catch it, because there is no uniqueness constraint anywhere.
--
-- So this migration does two separate things:
--
--   * lets a company say it does not use POs at all, so the field disappears
--     and orders flow through without it;
--   * makes the numbers that ARE used unique, and lets CHC issue them.
--
-- THE UNIQUENESS IS A CONSTRAINT, NOT A CHECK. Reading the table to see whether
-- a PO exists and then inserting is a race that two people pressing submit in
-- the same second will win together. A unique index cannot be raced.
--
-- HISTORY IS PRESERVED. The five existing duplicates are real orders, one of
-- them closed. They are not deleted and not rewritten. `po_normalized` is
-- backfilled only for the FIRST order in each duplicate group, so the others
-- fall outside the partial index and the constraint can be created without
-- destroying anything. They remain visible and searchable by po_number.
-- ============================================================

-- ------------------------------------------------------------
-- 1. How each order's PO came to exist
-- ------------------------------------------------------------
alter table public.orders
    add column if not exists po_source     text,
    add column if not exists po_normalized text;

alter table public.orders drop constraint if exists orders_po_source_chk;
alter table public.orders
    add constraint orders_po_source_chk
    check (po_source is null or po_source in ('generated', 'manual', 'none'));

comment on column public.orders.po_source is
    'generated = CHC issued it from the company sequence; manual = the shop supplied their own; none = the company does not use POs. NULL on orders placed before this existed.';
comment on column public.orders.po_normalized is
    'Upper-cased, trimmed po_number, used solely for the uniqueness constraint. NULL means the row is outside the constraint: either no PO, or a pre-existing duplicate kept for history.';

-- ------------------------------------------------------------
-- 2. Keep it correct automatically
--
-- A trigger rather than application code, so the guarantee holds no matter
-- which path writes the row — including a hand-fixed order in the console, or
-- a future importer nobody has written yet.
-- ------------------------------------------------------------
create or replace function public.orders_set_po_normalized()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    new.po_normalized := nullif(upper(btrim(coalesce(new.po_number, ''))), '');
    return new;
end;
$$;

revoke all on function public.orders_set_po_normalized() from public, anon, authenticated;

drop trigger if exists orders_po_normalized on public.orders;
create trigger orders_po_normalized
    before insert or update of po_number on public.orders
    for each row execute function public.orders_set_po_normalized();

-- ------------------------------------------------------------
-- 3. Backfill, keeping only the first of each duplicate group
-- ------------------------------------------------------------
with ranked as (
    select id,
           row_number() over (
               partition by company_id, upper(btrim(po_number))
               order by created_at, id
           ) as rn
      from public.orders
     where nullif(btrim(coalesce(po_number, '')), '') is not null
)
update public.orders o
   set po_normalized = upper(btrim(o.po_number)),
       po_source     = coalesce(o.po_source, 'manual')
  from ranked r
 where r.id = o.id and r.rn = 1;

-- ------------------------------------------------------------
-- 4. The constraint that actually prevents reuse
-- ------------------------------------------------------------
create unique index if not exists uq_orders_po_per_company
    on public.orders (company_id, po_normalized)
    where po_normalized is not null;

comment on index public.uq_orders_po_per_company is
    'A PO number may be used once per company. Partial so orders with no PO, and the pre-existing duplicates kept for history, sit outside it.';

-- ------------------------------------------------------------
-- 5. The counter
--
-- One row per company that has CHC issue its numbers. Allocation is an atomic
-- UPDATE ... RETURNING against this row: Postgres takes a row lock for the
-- duration, so concurrent allocations serialise and cannot collide.
--
-- The counter NEVER RESETS — not annually, not ever. Year-resets are the
-- commonest way a PO sequence reissues an old number. A company that wants the
-- year visible changes the prefix (ASR26) and keeps counting, which is safe
-- precisely because the prefix is part of the number.
-- ------------------------------------------------------------
create table if not exists public.company_po_sequences (
    company_id      uuid primary key references public.companies(id) on delete cascade,
    prefix          text    not null,
    next_number     bigint  not null default 1,
    pad_width       integer not null default 5,
    use_check_digit boolean not null default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    updated_by      uuid references public.admin_users(id) on delete set null,

    constraint po_prefix_shape_chk  check (prefix ~ '^[A-Z][A-Z0-9]{1,7}$'),
    constraint po_pad_width_chk     check (pad_width between 3 and 9),
    constraint po_next_number_chk   check (next_number > 0)
);

comment on table public.company_po_sequences is
    'Per-company PO counter. Allocation is an atomic UPDATE ... RETURNING on this row, which is what makes two simultaneous submits impossible to collide.';

-- Prefixes are unique across ALL companies, so a branch can tell whose order a
-- number belongs to from the number alone, with nothing to look up.
create unique index if not exists uq_po_prefix_global
    on public.company_po_sequences (upper(prefix));

alter table public.company_po_sequences enable row level security;
revoke all on public.company_po_sequences from anon, authenticated;

-- ------------------------------------------------------------
-- 6. Allocation
--
-- Returns the raw next number and leaves formatting to the application, so the
-- check-digit algorithm has exactly one implementation. Two implementations of
-- a check digit is two implementations that can drift, and a drifted check
-- digit is worse than none: it rejects numbers that are correct.
-- ------------------------------------------------------------
create or replace function public.allocate_po_number(p_company_id uuid)
returns table (prefix text, seq bigint, pad_width integer, use_check_digit boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    return query
    update public.company_po_sequences s
       set next_number = s.next_number + 1,
           updated_at  = now()
     where s.company_id = p_company_id
    returning s.prefix, s.next_number - 1, s.pad_width, s.use_check_digit;
end;
$$;

revoke all on function public.allocate_po_number(uuid) from public, anon, authenticated;

comment on function public.allocate_po_number(uuid) is
    'Atomically consumes the next PO number for a company. Returns no rows when the company has no sequence configured — the caller must treat that as "not set up", never as zero.';
