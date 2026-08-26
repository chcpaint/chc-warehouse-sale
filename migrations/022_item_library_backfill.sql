-- 022_item_library_backfill.sql
--
-- Two things, both driven by the August 2026 master catalogue that now sits in
-- item_library:
--
--   1. Give products the shops ALREADY sell a scannable barcode, where the
--      library has one and the product has none.
--   2. Record the ones we deliberately did not touch, so nobody has to
--      rediscover why later.
--
-- What this migration will NOT do, on purpose:
--
--   * It never overwrites a barcode. If a product already has one, the shop's
--     own value wins — it is the one on their shelf labels.
--   * It never adds a barcode that already points at a different product in
--     the same company. A scan has to resolve to exactly one item.
--   * It never adds a barcode the library gives to two different SKUs. The
--     clearest example is 3M 06652: the case and the single roll carry the
--     same manufacturer barcode, so a scanner cannot tell 1 roll from 1 case.
--     Guessing there would silently corrupt stock counts, so those are parked
--     for a person to decide.
--
-- Everything written here is tagged source = 'master_import_2026_08', so the
-- whole backfill is one DELETE away from being undone.

begin;

-- ------------------------------------------------------------------
-- The barcodes we can apply without ambiguity
-- ------------------------------------------------------------------

create temporary table _bc on commit drop as
with p as (
    select p.id, p.company_id, p.sku,
           upper(regexp_replace(p.sku, '[^A-Za-z0-9]', '', 'g')) as k
    from products p
    where p.is_active and coalesce(p.sku, '') <> ''
),
cand as (
    select p.id as product_id, p.company_id, p.sku, l.barcode
    from p
    join item_library l on l.sku_key = p.k
    where l.barcode is not null
      and not exists (select 1 from product_barcodes b where b.product_id = p.id)
),
-- a barcode the library hands to more than one SKU inside the same company
ambiguous as (
    select company_id, barcode from cand group by company_id, barcode having count(*) > 1
)
select c.*,
       case
           when a.barcode is not null then 'shared_by_two_skus'
           when exists (
               select 1 from product_barcodes b
               join products p2 on p2.id = b.product_id
               where p2.company_id = c.company_id and b.barcode = c.barcode
           ) then 'already_used_by_another_product'
           else 'ok'
       end as verdict
from cand c
left join ambiguous a on a.company_id = c.company_id and a.barcode = c.barcode;

insert into product_barcodes (product_id, barcode, symbology, is_primary, source, is_internal)
select product_id, barcode, 'upc_a', true, 'master_import_2026_08', false
from _bc
where verdict = 'ok';

-- ------------------------------------------------------------------
-- The ones a person has to look at
-- ------------------------------------------------------------------

create table if not exists public.item_library_conflicts (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    product_id uuid not null references products(id) on delete cascade,
    sku text not null,
    barcode text not null,
    reason text not null,
    resolved_at timestamptz,
    resolved_by uuid,
    created_at timestamptz not null default now(),
    constraint item_library_conflicts_unique unique (product_id, barcode)
);

comment on table public.item_library_conflicts is
    'Barcodes from the master catalogue that could not be applied automatically because a scan of them would be ambiguous. A person decides.';

insert into item_library_conflicts (company_id, product_id, sku, barcode, reason)
select company_id, product_id, sku, barcode, verdict
from _bc
where verdict <> 'ok'
on conflict (product_id, barcode) do nothing;

alter table public.item_library_conflicts enable row level security;
revoke all on public.item_library_conflicts from anon, authenticated;

create index if not exists idx_item_library_conflicts_open
    on public.item_library_conflicts (company_id) where resolved_at is null;

commit;
