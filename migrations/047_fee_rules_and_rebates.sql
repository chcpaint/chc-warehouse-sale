-- 047_fee_rules_and_rebates.sql
-- Per-company fee rules (delivery fee, fuel surcharge) and rebate rules, plus the
-- order columns that record which fees were charged.
--
-- Nothing changes for any company until it is given rules:
--   * a company with NO fee rules keeps today's behaviour (the $10 fee on an order
--     under $300, unless switched off on the Orders screen);
--   * a company with NO rebate rules has no rebate and no rebate reporting.
--
-- Safe to run more than once.

-- 1. Fee rules ------------------------------------------------------------
create table if not exists public.company_fee_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('delivery', 'fuel')),
  label varchar(80) not null,
  calc text not null check (calc in ('flat', 'percent')),
  amount numeric(10,2) not null check (amount > 0),
  -- When it applies, judged on the priced item subtotal (before tax):
  --   always | below (subtotal under threshold) | at_or_above (subtotal at or over threshold)
  condition text not null default 'always' check (condition in ('always', 'below', 'at_or_above')),
  threshold numeric(10,2) check (threshold is null or threshold >= 0),
  -- Empty = everyone ordering for the company. Otherwise only people in these groups
  -- (company_user_groups). The shared access code has no group, so it never matches.
  group_ids uuid[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fee_rule_threshold_needed check (condition = 'always' or threshold is not null),
  constraint fee_rule_percent_cap check (calc <> 'percent' or amount <= 100)
);
create index if not exists idx_company_fee_rules_company on public.company_fee_rules(company_id);
alter table public.company_fee_rules enable row level security;

-- 2. Rebate rules ---------------------------------------------------------
-- A standalone rebate on what a company actually paid for goods (after any product
-- discount, before tax and fees). Not applied at checkout: it is accrued per period
-- and shown in reporting, and CHC credits it outside the portal.
create table if not exists public.company_rebate_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  label varchar(80) not null,
  percent numeric(6,3) not null check (percent > 0 and percent <= 100),
  applies_to text not null default 'all' check (applies_to in ('all', 'selected')),
  categories text[] not null default '{}',
  brands text[] not null default '{}',
  frequency text not null default 'monthly' check (frequency in ('monthly', 'quarterly', 'annual')),
  starts_on date,
  ends_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rebate_selected_needs_scope check (
    applies_to = 'all' or cardinality(categories) > 0 or cardinality(brands) > 0),
  constraint rebate_dates_ordered check (starts_on is null or ends_on is null or starts_on <= ends_on)
);
create index if not exists idx_company_rebate_rules_company on public.company_rebate_rules(company_id);
alter table public.company_rebate_rules enable row level security;

-- 3. What an order was charged -------------------------------------------
-- delivery_fee already exists and keeps meaning "delivery-type fees". fuel_surcharge is
-- the fuel-type total; fee_lines is the itemised list shown on the order.
alter table public.orders
  add column if not exists fuel_surcharge numeric(10,2) not null default 0,
  add column if not exists fee_lines jsonb not null default '[]'::jsonb;
