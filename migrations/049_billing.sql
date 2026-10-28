-- 049_billing.sql
-- Subscriptions for the optional parts of the console. The sales portal
-- (ordering) is always free and has no row here.
-- Safe to run more than once.

-- Price list. A row with distributor_id NULL is a platform-wide default; a row
-- with a distributor_id overrides it for that distributor's customers. Anything
-- with no row falls back to the defaults in utils/billing.js.
create table if not exists public.billing_prices (
    id                uuid primary key default gen_random_uuid(),
    distributor_id    uuid references public.distributors(id) on delete cascade,
    item              text not null,
    "interval"        text not null,
    unit_amount_cents integer not null,
    currency          text not null default 'cad',
    updated_by        uuid,
    updated_at        timestamptz not null default now(),
    constraint billing_prices_item_chk check (item in ('inventory','kits','people','shopsafe','complete')),
    constraint billing_prices_interval_chk check ("interval" in ('month','year')),
    constraint billing_prices_amount_chk check (unit_amount_cents >= 0 and unit_amount_cents <= 100000000),
    constraint billing_prices_currency_chk check (currency in ('cad','usd'))
);
create unique index if not exists billing_prices_unique
    on public.billing_prices (coalesce(distributor_id, '00000000-0000-0000-0000-000000000000'::uuid), item, "interval");

-- What each customer company has right now, one row per item. 'paid' rows are
-- kept in step with Stripe by webhooks; 'comp' rows are a $0 grant by a
-- distributor super admin, always with a reason; 'free_price' rows are items a
-- distributor priced at $0.
create table if not exists public.company_entitlements (
    id                     uuid primary key default gen_random_uuid(),
    company_id             uuid not null references public.companies(id) on delete cascade,
    distributor_id         uuid references public.distributors(id) on delete set null,
    item                   text not null,
    status                 text not null default 'active',
    source                 text not null default 'paid',
    "interval"             text,
    quantity               integer not null default 1,
    unit_amount_cents      integer not null default 0,
    currency               text not null default 'cad',
    stripe_customer_id     text,
    stripe_subscription_id text,
    current_period_end     timestamptz,
    cancel_at_period_end   boolean not null default false,
    comp_reason            text,
    comp_until             timestamptz,
    granted_by             uuid,
    created_at             timestamptz not null default now(),
    updated_at             timestamptz not null default now(),
    constraint company_entitlements_item_chk check (item in ('inventory','kits','people','shopsafe','complete')),
    constraint company_entitlements_status_chk check (status in ('active','trialing','past_due','canceled','unpaid','comped')),
    constraint company_entitlements_source_chk check (source in ('paid','comp','free_price')),
    constraint company_entitlements_interval_chk check ("interval" is null or "interval" in ('month','year')),
    constraint company_entitlements_unique unique (company_id, item)
);
create index if not exists company_entitlements_sub_idx on public.company_entitlements (stripe_subscription_id);
create index if not exists company_entitlements_dist_idx on public.company_entitlements (distributor_id);

-- Every Stripe event we have handled, so a retried webhook is never applied twice.
create table if not exists public.billing_events (
    stripe_event_id text primary key,
    type            text not null,
    received_at     timestamptz not null default now()
);

alter table public.billing_prices        enable row level security;
alter table public.company_entitlements  enable row level security;
alter table public.billing_events        enable row level security;
revoke all on public.billing_prices       from anon, authenticated;
revoke all on public.company_entitlements from anon, authenticated;
revoke all on public.billing_events       from anon, authenticated;
