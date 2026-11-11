-- 066_distributor_licensing.sql
--
-- Licensing refinishAI to distributors other than CHC.
--
-- 1. Licence terms on each distributor (plan, status, term, fee, renewal, trial,
--    limits) plus the short name, support email and country the app shows.
--    CHC is recorded as the founding distributor: active, no fee.
-- 2. orders.distributor_id, filled from the order's company (backfilled once,
--    then by trigger), so every staff screen can be fenced to one distributor.
-- 3. The Item Library's import history and change log carry distributor_id too,
--    and the library search only returns the company's own distributor's items.
--
-- Safe to run more than once. Existing CHC data is only labelled, never changed.

-- ---------- 1. Licence terms ----------
alter table public.distributors
  add column if not exists short_name            varchar(40),
  add column if not exists support_email         varchar(255),
  add column if not exists country               varchar(2) not null default 'CA',
  add column if not exists licence_plan          varchar(40) not null default 'standard',
  add column if not exists licence_status        varchar(20) not null default 'active',
  add column if not exists licence_term          varchar(10) not null default 'annual',
  add column if not exists licence_fee           numeric(10,2) not null default 0,
  add column if not exists licence_currency      varchar(3) not null default 'CAD',
  add column if not exists licence_started_on    date,
  add column if not exists licence_renews_on     date,
  add column if not exists trial_ends_on         date,
  add column if not exists max_companies         int,
  add column if not exists billing_contact_email varchar(255),
  add column if not exists licence_notes         text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'distributors_licence_status_check') then
    alter table public.distributors add constraint distributors_licence_status_check
      check (licence_status in ('trial', 'active', 'past_due', 'suspended', 'cancelled'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'distributors_licence_term_check') then
    alter table public.distributors add constraint distributors_licence_term_check
      check (licence_term in ('monthly', 'annual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'distributors_licence_currency_check') then
    alter table public.distributors add constraint distributors_licence_currency_check
      check (licence_currency in ('CAD', 'USD'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'distributors_country_check') then
    alter table public.distributors add constraint distributors_country_check check (country in ('CA', 'US'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'distributors_max_companies_check') then
    alter table public.distributors add constraint distributors_max_companies_check check (max_companies is null or max_companies >= 0);
  end if;
end
$$;

-- The founding distributor.
update public.distributors
   set short_name = coalesce(short_name, 'CHC'),
       support_email = coalesce(support_email, 'info@chcpaint.com'),
       licence_plan = 'founding',
       licence_started_on = coalesce(licence_started_on, created_at::date)
 where is_default and (short_name is null or licence_plan <> 'founding');

-- ---------- 2. orders.distributor_id ----------
alter table public.orders add column if not exists distributor_id uuid references public.distributors(id);

-- Backfill without touching updated_at or any other order trigger: the label is
-- new information, not a change to the order.
do $$
declare t record;
begin
  for t in select tgname from pg_trigger where tgrelid = 'public.orders'::regclass and not tgisinternal loop
    execute format('alter table public.orders disable trigger %I', t.tgname);
  end loop;
  update public.orders o
     set distributor_id = c.distributor_id
    from public.companies c
   where c.id = o.company_id and o.distributor_id is null;
  for t in select tgname from pg_trigger where tgrelid = 'public.orders'::regclass and not tgisinternal loop
    execute format('alter table public.orders enable trigger %I', t.tgname);
  end loop;
end
$$;

create or replace function public.orders_set_distributor()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.distributor_id is null or tg_op = 'UPDATE' and new.company_id is distinct from old.company_id then
    select distributor_id into new.distributor_id from public.companies where id = new.company_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orders_set_distributor on public.orders;
create trigger trg_orders_set_distributor
  before insert or update of company_id on public.orders
  for each row execute function public.orders_set_distributor();

create index if not exists idx_orders_distributor_created on public.orders (distributor_id, created_at desc);

-- ---------- 3. Item Library history, per distributor ----------
do $$
declare
  d uuid := (select id from public.distributors where is_default limit 1);
  t text;
begin
  foreach t in array array['item_library_changes', 'item_library_imports'] loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I add column if not exists distributor_id uuid references public.distributors(id)', t);
      execute format('update public.%I set distributor_id = %L where distributor_id is null', t, d);
      execute format('alter table public.%I alter column distributor_id set default %L', t, d);
      execute format('alter table public.%I alter column distributor_id set not null', t);
      execute format('create index if not exists %I on public.%I (distributor_id)', 'idx_' || t || '_distributor', t);
    end if;
  end loop;
end
$$;

-- Library search: only the items of the company's own distributor.
create or replace function public.search_item_library(
    p_company_id uuid,
    p_query      text,
    p_vendors    text[] default null,
    p_only_new   boolean default false,
    p_limit      int default 50,
    p_offset     int default 0,
    p_lines      text[] default null
)
returns table (
    id uuid, sku text, name text, brand text, vendor_code text,
    barcode text, unit text, case_qty numeric, list_price numeric,
    already_in_catalogue boolean, existing_product_id uuid, rank real,
    total_count bigint
)
language sql
stable
set search_path = public, extensions, pg_catalog
as $fn$
with q as (
    select
        coalesce(trim(p_query), '')                                          as raw,
        upper(regexp_replace(coalesce(p_query,''), '[^A-Za-z0-9]', '', 'g'))  as key,
        (select coalesce(array_agg(w), '{}')
           from unnest(regexp_split_to_array(lower(coalesce(trim(p_query),'')), '\s+')) w
          where length(w) > 0)                                               as words
),
dist as (
    select c.distributor_id from companies c where c.id = p_company_id
),
mine as (
    select p.id,
           upper(regexp_replace(coalesce(p.sku,''), '[^A-Za-z0-9]', '', 'g')) as k
    from products p
    where p.company_id = p_company_id and coalesce(p.sku,'') <> ''
),
hits as (
    select l.*,
           m.id as existing_product_id,
           case
               when q.key <> '' and l.sku_key = q.key                  then 1000.0
               when q.raw <> '' and l.barcode = q.raw                  then 900.0
               when q.key <> '' and l.sku_key like q.key || '%'        then 500.0 + similarity(l.sku_key, q.key)
               when q.key <> '' and l.sku_key like '%' || q.key || '%' then 300.0 + similarity(l.sku_key, q.key)
               else 100.0 + similarity(lower(l.name), lower(q.raw))
           end::real as rank
    from item_library l
    cross join q
    join dist on dist.distributor_id = l.distributor_id
    left join mine m on m.k = l.sku_key
    where (p_vendors is null or l.vendor_code = any (p_vendors))
      and (p_lines is null or cardinality(p_lines) = 0 or exists (
            select 1 from unnest(p_lines) t
             where t <> ''
               and lower(concat_ws(' ', l.brand, l.category, l.name, l.sku)) like '%' || lower(t) || '%'))
      and (
            q.raw = ''
            or (q.key <> '' and l.sku_key like '%' || q.key || '%')
            or l.barcode = q.raw
            or (cardinality(q.words) > 0
                and not exists (
                    select 1 from unnest(q.words) w
                    where lower(concat_ws(' ', l.name, l.sku, l.brand, l.category)) not like '%' || w || '%'
                ))
          )
      and (not p_only_new or m.id is null)
)
select h.id, h.sku, h.name, h.brand, h.vendor_code, h.barcode, h.unit,
       h.case_qty, h.list_price,
       (h.existing_product_id is not null) as already_in_catalogue,
       h.existing_product_id,
       h.rank,
       count(*) over () as total_count
from hits h
order by h.rank desc nulls last, h.sku
limit greatest(1, least(coalesce(p_limit, 50), 200))
offset greatest(0, coalesce(p_offset, 0));
$fn$;

-- Check:
--   select name, short_name, licence_plan, licence_status from public.distributors;
--   select count(*) filter (where distributor_id is null) as orders_without_distributor from public.orders;
