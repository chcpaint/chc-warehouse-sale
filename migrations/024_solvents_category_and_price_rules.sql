-- 024_solvents_category_and_price_rules.sql
--
-- Two standing rules, plus the one-off move that prompted them.
--
-- WHY THESE ARE TRIGGERS AND NOT APPLICATION CODE
--
-- The 25 August 2026 import that mispriced 168 of Concord's lines did not come
-- through the ordering screens. It wrote straight to `products`. A guard in
-- Node would never have seen it. A trigger sees every write, whatever the path
-- — CSV upload, admin console, a migration script, or somebody in the SQL
-- editor at 11pm. If a control can be walked around, it is not a control.

begin;

-- ==================================================================
-- The move: standalone chemicals get their own category
-- ==================================================================
--
-- Only items sitting in 'Misc' or 'Polish/Comp/Soap' move. Reducers and
-- hardeners filed under Colour, Primer/Sealer or Clearcoat stay exactly where
-- they are: PPG DT1850, ECR75, ECR85, TFS309 and friends are components of a
-- paint system, and a painter looks for them beside the paint they thin, not in
-- a general solvents bin. Moving those would break how the shop already thinks
-- about its own catalogue, which is worse than the tidiness is worth.

update products p
set category = 'Solvents/Chemicals', updated_at = now()
where p.is_active
  and p.category in ('Misc', 'Polish/Comp/Soap')
  and (
        p.name ~* '(gun ?wash|final wash|solvent wash|wax ?(and|&) ?grease|degreas)'
     or p.name ~* '(reducer|thinner|acetone|isopropyl|iso alcohol|alcohol 99|solvent cleaner|tool ?& ?equipment cleaner|adhesive remover)'
      )
  and p.name !~* '(filter|holder|applicator|hose|spigot|faucet|crimper|tipper|spout|gauge|pad)';

-- ==================================================================
-- RULE 1 — a price cannot silently land a decimal place from list
-- ==================================================================

create table if not exists public.price_anomalies (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid references companies(id) on delete cascade,
    product_id      uuid references products(id) on delete cascade,
    sku             text not null,
    name            text,
    attempted_price numeric not null,
    list_price      numeric not null,
    ratio           numeric not null,
    severity        text not null,
    detected_at     timestamptz not null default now(),
    resolved_at     timestamptz,
    note            text
);

comment on table public.price_anomalies is
    'Prices far enough from the supplier list price to be a decimal error rather than a deal. Written by trg_products_price_sanity.';

alter table public.price_anomalies enable row level security;
revoke all on public.price_anomalies from anon, authenticated;
create index if not exists idx_price_anomalies_open
    on public.price_anomalies (company_id) where resolved_at is null;

-- Thresholds, and why they are where they are:
--
--   below 0.15  refuse. Nothing legitimate sits there. The case that prompted
--               this was a $1,250 Rupes polisher listed at $119.90.
--   below 0.30  record, allow. Real trade discounts reach here.
--   above 4.00  record, allow. Usually a case price against a per-unit list —
--               a box of ten filters priced at ten times one filter — which is
--               correct but worth a human glance.
--
-- Deliberately NOT blocking the middle bands: Louie's negotiated $69.99 on the
-- 3M 092 hundred-packs is 0.50 of list and entirely real. A rule that refused
-- that would be turned off within a week, and a rule that is off protects
-- nothing.
create or replace function public.products_price_sanity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $fn$
declare
    lp    numeric;
    r     numeric;
    allow text := current_setting('chc.allow_price_outliers', true);
begin
    if new.price is null or new.price = 0 or coalesce(new.price_on_request, false) then
        return new;                       -- no price, or a deliberate "ask us" line
    end if;

    select list_price into lp
    from item_library
    where sku_key = upper(regexp_replace(coalesce(new.sku,''), '[^A-Za-z0-9]', '', 'g'))
    limit 1;

    if lp is null or lp = 0 then
        return new;                       -- part is not in the reference catalogue
    end if;

    -- Never fire on an edit that leaves the price alone.
    if tg_op = 'UPDATE' and old.price is not distinct from new.price then
        return new;
    end if;

    r := new.price / lp;

    if r < 0.15 and allow is distinct from 'on' then
        raise exception using
            errcode = 'check_violation',
            message = format(
                'Price %s for %s is %s%% of the %s list price — that is a decimal error, not a discount.',
                to_char(new.price,'FM999990.00'), new.sku,
                to_char(r*100,'FM990.0'), to_char(lp,'FM999990.00')),
            hint = 'If this price really is intended, run: '
                || 'select set_config(''chc.allow_price_outliers'', ''on'', true); '
                || 'in the same transaction, and the write will be recorded rather than refused.';
    end if;

    if r < 0.30 or r > 4.0 then
        insert into price_anomalies
            (company_id, product_id, sku, name, attempted_price, list_price, ratio, severity, note)
        values
            (new.company_id, new.id, new.sku, new.name, new.price, lp, round(r,4),
             case when r < 0.15 then 'blocked-override' else 'flagged' end,
             case when r < 0.15 then 'Written with chc.allow_price_outliers set.'
                  else 'Outside the normal band against supplier list price.' end);
    end if;

    return new;
end;
$fn$;

drop trigger if exists trg_products_price_sanity on public.products;
create trigger trg_products_price_sanity
    before insert or update of price on public.products
    for each row execute function public.products_price_sanity();

-- ==================================================================
-- RULE 2 — chemicals file themselves
-- ==================================================================

create or replace function public.suggest_product_category(p_name text)
returns text
language sql
immutable
set search_path = public, pg_catalog
as $fn$
    select case
        when p_name ~* '(filter|holder|applicator|hose|spigot|faucet|crimper|tipper|spout|gauge|pad)'
            then null
        when p_name ~* '(gun ?wash|final wash|solvent wash|wax ?(and|&) ?grease|degreas)'
          or p_name ~* '(reducer|thinner|acetone|isopropyl|iso alcohol|alcohol 99|solvent cleaner|tool ?& ?equipment cleaner|adhesive remover)'
            then 'Solvents/Chemicals'
        else null
    end;
$fn$;

-- Fills a gap; never overrules a person. 'Misc' counts as a gap because it is
-- what an importer writes when it has nothing better, not a decision anyone
-- made. A category chosen deliberately is left alone.
create or replace function public.products_default_category()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $fn$
declare
    suggested text;
begin
    if new.category is null or new.category = '' or new.category = 'Misc' then
        suggested := suggest_product_category(coalesce(new.name, ''));
        if suggested is not null then
            new.category := suggested;
        end if;
    end if;
    return new;
end;
$fn$;

drop trigger if exists trg_products_default_category on public.products;
create trigger trg_products_default_category
    before insert on public.products
    for each row execute function public.products_default_category();

-- ==================================================================
-- Seed the queue with what is already on the books
-- ==================================================================
--
-- A rule that only knows about the future leaves the existing damage invisible.

insert into price_anomalies
    (company_id, product_id, sku, name, attempted_price, list_price, ratio, severity, note)
select p.company_id, p.id, p.sku, regexp_replace(p.name,'^\s*\*\s*',''),
       p.price, l.list_price, round((p.price / l.list_price)::numeric, 4),
       case when p.price / l.list_price < 0.15 then 'pre-existing-severe' else 'pre-existing' end,
       'Present before the rule was added.'
from products p
join item_library l on l.sku_key = upper(regexp_replace(p.sku,'[^A-Za-z0-9]','','g'))
where p.is_active and p.price > 0 and not p.price_on_request
  and l.list_price > 0
  and (p.price / l.list_price < 0.30 or p.price / l.list_price > 4.0)
  and not exists (select 1 from price_anomalies pa where pa.product_id = p.id);

commit;
