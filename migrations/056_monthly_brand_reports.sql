-- ============================================================================
-- 056_monthly_brand_reports.sql
--
-- Monthly brand sales reports (first customer: Assured, brand 3M).
--
-- Two small tables, both new. Nothing here touches the companies table, a
-- company's settings, or anything that decides how a customer signs in:
--
--   brand_report_subscriptions  which customer gets which brand's monthly
--                               report. A table of its own rather than a
--                               company setting, so turning a report on or off
--                               can never be confused with, or collide with,
--                               an access-code or sign-in setting.
--
--   monthly_brand_reports       one frozen snapshot per customer, brand and
--                               month. The Excel and PDF files are rendered
--                               from the snapshot, so a re-download next year
--                               is identical to the first one, and the year to
--                               date is built from the same stored months.
--
-- The report is produced by the app's own scheduler on the 1st of each month
-- (utils/scheduler.js); a super admin can also generate or regenerate any
-- finished month from Reports > Monthly brand.
--
-- RLS is on with no policy: the deny-all backstop used across this schema.
-- Everything reaches these tables through the service role only.
--
-- Safe to run more than once. No temp tables, no transaction control.
-- ============================================================================

create table if not exists public.brand_report_subscriptions (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references public.companies(id) on delete cascade,
    brand       text not null,
    is_enabled  boolean not null default true,
    created_at  timestamptz not null default now(),
    constraint brand_report_subscriptions_unique unique (company_id, brand)
);

comment on table public.brand_report_subscriptions is
    'Which customer receives which brand''s monthly sales report. Separate from company settings on purpose.';

create table if not exists public.monthly_brand_reports (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references public.companies(id) on delete cascade,
    brand         text not null,
    period        text not null,
    basis         text not null default 'shipped',
    source        text not null default 'scheduled',
    generated_at  timestamptz not null default now(),
    generated_by  uuid references public.admin_users(id) on delete set null,
    order_count   integer not null default 0,
    total_qty     numeric not null default 0,
    total_amount  numeric(14,2) not null default 0,
    data          jsonb not null,
    constraint monthly_brand_reports_unique unique (company_id, brand, period),
    constraint monthly_brand_reports_period_chk check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    constraint monthly_brand_reports_source_chk check (source in ('scheduled', 'manual', 'backfill'))
);

comment on table public.monthly_brand_reports is
    'Frozen monthly snapshot of a customer''s sales of one brand. Files are rendered from data, never rebuilt from live orders, so a past month does not move.';
comment on column public.monthly_brand_reports.period is
    'Calendar month in Toronto time, YYYY-MM.';
comment on column public.monthly_brand_reports.basis is
    'What counted as a sale. shipped = quantity shipped (Out for Delivery or Closed), dated when it shipped, before tax and fees.';

create index if not exists idx_monthly_brand_reports_company
    on public.monthly_brand_reports (company_id, brand, period desc);

alter table public.brand_report_subscriptions enable row level security;
alter table public.monthly_brand_reports      enable row level security;
revoke all on public.brand_report_subscriptions from anon, authenticated;
revoke all on public.monthly_brand_reports      from anon, authenticated;

-- ------------------------------------------------------------
-- First subscription: Assured, 3M. Matched by name, and it does nothing at
-- all unless exactly one company matches -- a report switched on for the wrong
-- customer is worse than one nobody switched on.
-- ------------------------------------------------------------
do $$
declare
    n int;
    target uuid;
    target_name text;
begin
    select count(*) into n from public.companies where name ilike 'assured%';
    if n = 1 then
        select id, name into target, target_name from public.companies where name ilike 'assured%';
        insert into public.brand_report_subscriptions (company_id, brand)
        values (target, '3M')
        on conflict (company_id, brand) do nothing;
        raise notice 'Monthly 3M report switched on for %', target_name;
    else
        raise notice 'Found % companies matching "Assured" -- no subscription was created. Add one with: insert into brand_report_subscriptions (company_id, brand) values (''<company id>'', ''3M'');', n;
    end if;
end $$;
