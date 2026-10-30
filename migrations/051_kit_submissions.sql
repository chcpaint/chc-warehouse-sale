-- 051_kit_submissions.sql
--
-- Insurance Kit Submissions: a shop picks a repair kit, adds the repair order
-- and claim details, and gets a numbered PDF itemizing the kit's materials to
-- load into Mitchell / CCC ONE / Audatex. It stands on its own -- no inventory
-- module, no stock movement -- and every PDF is saved to the shop's console.
--
-- Three things matter here:
--   1. A submission number that is unique to the shop and can never repeat. It
--      comes from a per-company counter incremented under a row lock, so two
--      people generating at the same moment cannot receive the same number.
--   2. What was submitted is frozen. The lines, prices and names are copied in
--      at generation time; nothing a catalogue or kit does later changes a
--      document an insurer already holds.
--   3. A submission is never deleted. It can be marked Paid or Voided (with a
--      reason), so the number stays accounted for.
--
-- Safe to re-run.

-- ------------------------------------------------------------
-- 1. Per-company counter (service role only)
-- ------------------------------------------------------------
create table if not exists public.kit_submission_counters (
    company_id uuid primary key references public.companies(id) on delete cascade,
    prefix     text not null,
    last_no    integer not null default 0,
    created_at timestamptz not null default now(),
    constraint kit_submission_counters_prefix_key unique (prefix),
    constraint kit_submission_counters_prefix_chk check (prefix ~ '^[A-Z0-9]{2,8}$')
);
alter table public.kit_submission_counters enable row level security;
revoke all on public.kit_submission_counters from anon, authenticated;

comment on table public.kit_submission_counters is
    'One row per company: the prefix its submission numbers carry (unique across the platform) and the last number issued.';

-- Returns the next number for a company, e.g. ACC-00007. The prefix is chosen on
-- first use (p_prefix, with a digit appended if another company already has it)
-- and never changes afterwards. The UPDATE takes a row lock, which is what makes
-- concurrent callers receive different numbers.
create or replace function public.next_kit_submission_no(p_company uuid, p_prefix text)
returns text
language plpgsql
as $$
declare
    v_prefix text;
    v_no     integer;
    v_try    text;
    v_n      integer := 0;
begin
    if not exists (select 1 from public.kit_submission_counters where company_id = p_company) then
        v_prefix := upper(regexp_replace(coalesce(p_prefix, ''), '[^A-Za-z0-9]', '', 'g'));
        if length(v_prefix) < 2 then v_prefix := 'SHOP'; end if;
        v_prefix := left(v_prefix, 6);
        v_try := v_prefix;
        loop
            begin
                insert into public.kit_submission_counters (company_id, prefix)
                values (p_company, v_try)
                on conflict (company_id) do nothing;
                exit;
            exception when unique_violation then
                -- prefix taken by another company: ShopA -> SHOPA1, SHOPA2 ...
                v_n := v_n + 1;
                v_try := left(v_prefix, 6) || v_n::text;
                if v_n > 99 then raise; end if;
            end;
        end loop;
    end if;

    update public.kit_submission_counters
       set last_no = last_no + 1
     where company_id = p_company
 returning prefix, last_no into v_prefix, v_no;

    return v_prefix || '-' || lpad(v_no::text, 5, '0');
end;
$$;
revoke all on function public.next_kit_submission_no(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 2. The submissions
-- ------------------------------------------------------------
create table if not exists public.kit_submissions (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references public.companies(id) on delete cascade,
    location_id     uuid references public.company_locations(id) on delete set null,
    submission_no   text not null,

    kit_id          uuid references public.repair_kits(id) on delete set null,
    kit_name        text not null,
    multiplier      numeric(8,4) not null default 1,

    ro_number       varchar(60) not null,
    claim_no        varchar(60),
    insurer         varchar(120),
    vehicle         varchar(160),
    vin             varchar(20),
    notes           text,

    line_count      integer not null default 0,
    total_amount    numeric(12,2) not null default 0,
    lines_snapshot  jsonb not null,

    status          varchar(10) not null default 'issued',
    paid_at         timestamptz,
    voided_at       timestamptz,
    void_reason     text,

    created_by_name    text,
    created_by_user_id uuid references public.company_users(id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    constraint kit_submissions_status_chk check (status in ('issued','paid','void')),
    constraint kit_submissions_multiplier_chk check (multiplier > 0 and multiplier <= 100),
    constraint kit_submissions_company_no_key unique (company_id, submission_no),
    constraint kit_submissions_no_key unique (submission_no)
);

comment on table public.kit_submissions is
    'Insurance Kit Submissions: one numbered, itemized materials document per kit per repair order. Lines are frozen at generation.';

create index if not exists idx_kit_submissions_company_created on public.kit_submissions(company_id, created_at desc);
create index if not exists idx_kit_submissions_company_ro      on public.kit_submissions(company_id, ro_number);
create index if not exists idx_kit_submissions_company_claim   on public.kit_submissions(company_id, claim_no) where claim_no is not null;

alter table public.kit_submissions enable row level security;
revoke all on public.kit_submissions from anon, authenticated;

-- What was submitted cannot be rewritten, and a submission cannot be deleted
-- (except by deleting the whole company). Only its payment status moves.
create or replace function public.kit_submissions_guard()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'DELETE' then
        -- Allowed only as part of deleting the company itself.
        if exists (select 1 from public.companies where id = old.company_id) then
            raise exception 'Kit submissions cannot be deleted; void the submission instead.';
        end if;
        return old;
    end if;

    if new.company_id     is distinct from old.company_id
    or new.submission_no  is distinct from old.submission_no
    or new.kit_name       is distinct from old.kit_name
    or new.multiplier     is distinct from old.multiplier
    or new.ro_number      is distinct from old.ro_number
    or new.claim_no       is distinct from old.claim_no
    or new.insurer        is distinct from old.insurer
    or new.vehicle        is distinct from old.vehicle
    or new.vin            is distinct from old.vin
    or new.notes          is distinct from old.notes
    or new.line_count     is distinct from old.line_count
    or new.total_amount   is distinct from old.total_amount
    or new.lines_snapshot is distinct from old.lines_snapshot
    or new.created_at     is distinct from old.created_at then
        raise exception 'A submitted document cannot be changed. Void it and generate a new one.';
    end if;

    new.updated_at := now();
    return new;
end;
$$;
revoke all on function public.kit_submissions_guard() from public, anon, authenticated;

drop trigger if exists trg_kit_submissions_guard on public.kit_submissions;
create trigger trg_kit_submissions_guard
    before update or delete on public.kit_submissions
    for each row execute function public.kit_submissions_guard();
