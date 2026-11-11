-- 063_report_item_groups.sql
--
-- PPG paint lines vs sundries reporting (utils/report-groups.js).
--
-- 1. report_item_groups: CHC's corrections. The software sorts every item into
--    "PPG paint lines" or "Sundries" by rule; where the rule is wrong for a
--    part number, a CHC super admin sets it here and that wins everywhere
--    (reports and rebates). Keyed by the part number with punctuation removed,
--    upper case, so "JC830/01" and "jc830-01" are the same item.
--
-- 2. company_rebate_rules.applies_to also allows 'ppg_paint' and 'sundries', so
--    a rebate can be paid on PPG paint lines only (general PPG items such as
--    paint suits excluded) or on sundries only. Existing rules are unchanged.
--
-- Safe to run more than once. Touches nothing else: no orders, prices,
-- products, companies or sign-in settings.

create table if not exists public.report_item_groups (
  sku_key      text primary key check (sku_key ~ '^[A-Z0-9]{1,80}$'),
  sku          text not null,
  report_group text not null check (report_group in ('ppg', 'sundries')),
  reason       varchar(200),
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);

-- Server-only table (the service role bypasses RLS). No policies: nobody
-- reaches it through the public API.
alter table public.report_item_groups enable row level security;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'company_rebate_rules') then
    alter table public.company_rebate_rules drop constraint if exists company_rebate_rules_applies_to_check;
    alter table public.company_rebate_rules
      add constraint company_rebate_rules_applies_to_check
      check (applies_to in ('all', 'selected', 'ppg_paint', 'sundries'));
    -- Only "selected" needs categories or brands; the two group scopes do not.
    alter table public.company_rebate_rules drop constraint if exists rebate_selected_needs_scope;
    alter table public.company_rebate_rules
      add constraint rebate_selected_needs_scope
      check (applies_to <> 'selected' or cardinality(categories) > 0 or cardinality(brands) > 0);
  end if;
end
$$;

-- Check:
--   select count(*) from public.report_item_groups;
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'company_rebate_rules_applies_to_check';
