-- ============================================================================
-- 030_closed_catalogues.sql
--
-- A catalogue that is closed to bulk additions.
--
-- The PPG rule in 029 says "this customer does not get that brand". This is
-- the stronger case: Assured's list is a specific, agreed set of items, and
-- NOTHING new should reach it from a push — not PPG, not 3M, not anything.
-- Every other customer is on an open CHC contract and should receive the
-- master table in full.
--
-- Why a policy row rather than one exclusion per brand: brand rules have to be
-- maintained, and the day someone adds a brand to the master that nobody has
-- written a rule for, it lands in Assured's catalogue. A closed catalogue is
-- closed to things that do not exist yet, which is the only version of this
-- that stays correct without anyone remembering to maintain it.
--
-- What it does NOT block: adding a single item deliberately on that customer's
-- Products screen. Someone typing one part number is not the failure mode this
-- guards against; a bulk push of 878 items is.
--
-- Safe to run more than once. No temp tables, no transaction control.
-- ============================================================================

create table if not exists public.company_catalogue_policy (
    company_id  uuid primary key references public.companies(id) on delete cascade,
    push_mode   text not null default 'open',
    reason      text not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references public.admin_users(id) on delete set null,

    constraint company_catalogue_policy_mode_chk
        check (push_mode in ('open', 'closed'))
);

comment on table public.company_catalogue_policy is
    'Whether a customer may receive items from the master table in bulk. No row means open, which is the normal case. Closed means a push adds them nothing, including brands that do not exist yet.';
comment on column public.company_catalogue_policy.reason is
    'Written for the next person, not for the system. Why is this catalogue closed, and what would have to change for it to open?';

alter table public.company_catalogue_policy enable row level security;
revoke all on public.company_catalogue_policy from anon, authenticated;

-- Close Assured. Matched by name rather than a hard-coded id, and it does
-- nothing at all if no such customer exists — a migration that closed the
-- wrong customer's catalogue would be worse than one that closed none.
do $$
declare
    target uuid;
    target_name text;
begin
    select id, name into target, target_name
      from public.companies
     where name ilike 'assured%'
     order by created_at
     limit 1;

    if target is not null then
        insert into public.company_catalogue_policy (company_id, push_mode, reason)
        values (target, 'closed',
                'This customer''s list is a specific agreed set of items, not the CHC contract catalogue. '
                'Nothing new reaches it from a push. Add an item on their Products screen if it is genuinely intended.')
        on conflict (company_id) do update
            set push_mode = 'closed',
                reason    = excluded.reason,
                updated_at = now();
        raise notice 'Catalogue closed for %', target_name;
    else
        raise notice 'No company matching "Assured" found — no catalogue was closed. Set it on the Master Table screen.';
    end if;
end $$;

-- ------------------------------------------------------------
-- Fold the policy into the entitlement view, so the screen that previews a
-- push and the code that performs one read the same rule from one place.
--
-- A closed catalogue is entitled to exactly what it already holds. Expressed
-- here as "entitled only where the customer already has that part", which is
-- what makes it closed to parts nobody has thought of yet.
-- ------------------------------------------------------------
create or replace view public.v_company_catalogue_entitlement
with (security_invoker = true) as
select
    c.id                as company_id,
    c.name              as company_name,
    l.id                as item_id,
    l.sku,
    l.sku_key,
    l.name              as item_name,
    l.brand,
    l.category,
    l.barcode,
    l.list_price,
    coalesce(pol.push_mode, 'open')                        as push_mode,
    (
        x.id is null
        and (
            coalesce(pol.push_mode, 'open') = 'open'
            or exists (
                select 1 from public.products p
                 where p.company_id = c.id
                   and upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g')) = l.sku_key
            )
        )
    )                                                       as entitled,
    coalesce(x.reason, case when coalesce(pol.push_mode, 'open') = 'closed'
                            then pol.reason end)            as excluded_reason
  from public.companies c
 cross join public.item_library l
  left join public.company_catalogue_exclusions x
         on x.company_id = c.id
        and (   (x.brand    is not null and lower(x.brand)    = lower(l.brand))
             or (x.category is not null and lower(x.category) = lower(l.category))
             or (x.sku_key  is not null and x.sku_key         = l.sku_key))
  left join public.company_catalogue_policy pol
         on pol.company_id = c.id
 where c.is_active
   and l.is_active;

comment on view public.v_company_catalogue_entitlement is
    'Every master item against every customer, with entitled=false and a reason where a brand rule or a closed catalogue says they must not receive it.';
