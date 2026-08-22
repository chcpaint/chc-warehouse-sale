-- ============================================================
-- 016 — Repair kits: expense a job's materials in one action
--
-- The tables `repair_kits`, `kit_items` and `company_kit_access` already existed
-- in this database. They were loaded from a Skyline (Weins) export — 15 kits,
-- 53 lines — but they were never wired to anything: no migration created them,
-- no route reads them, no company has one enabled, and every single kit line has
-- `product_id` NULL. They are structure without meaning.
--
-- This migration makes them real, and adds the two things they were missing.
--
-- 1. WHOSE KIT IS IT.  `repair_kits.company_id` is added, nullable.
--       NULL  = a CHC master kit, curated centrally, offered to companies
--               through the existing `company_kit_access` table.
--       set   = a kit a shop built for itself; nobody else can see it.
--    The 15 imported kits stay NULL, which is what they are.
--
-- 2. WHAT THE LINE MEANS FOR *THIS* SHOP.  A master kit line is a SKU string.
--    Products are per-company, so the same SKU is a different row in every
--    company — and 13 of the 17 SKUs in the imported kits do not exist in the
--    CHC catalogue at all, because they are Skyline's part numbers, not ours.
--    `kit_product_map` is where each company records what a line actually means
--    on their shelf: which product, how much of it, or that it does not apply.
--    Resolution is therefore per-company data, never a guess made at run time.
--
-- The consumption itself needs no new movement machinery. A kit consume writes
-- ordinary `consume` rows to `stock_movements`, all carrying the same
-- `source_doc_type = 'kit_consume'` and `source_doc_id`, so on-hand is derived
-- by the existing trigger, the append-only guarantee still holds, and the Usage
-- and job-costing views pick the lines up with no change. `kit_consumptions` is
-- the header those rows point at.
--
-- Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ownership and housekeeping on the imported tables
-- ------------------------------------------------------------

alter table public.repair_kits
    add column if not exists company_id uuid references public.companies(id) on delete cascade,
    add column if not exists updated_at timestamptz not null default now();

comment on column public.repair_kits.company_id is
    'NULL = CHC master kit, offered via company_kit_access. Set = a kit private to that company.';

create index if not exists idx_repair_kits_company on public.repair_kits(company_id) where company_id is not null;
create index if not exists idx_kit_items_kit      on public.kit_items(kit_id);

-- A kit line must carry a positive quantity. The import contains one line at
-- zero (Raw Bumper Kit / MMM07745), which would be rejected by the ledger's
-- own non-zero check at consume time anyway — better to mark it here, where
-- someone can see it, than to fail silently on the shop floor.
alter table public.kit_items
    add column if not exists needs_review boolean not null default false;

update public.kit_items set needs_review = true where quantity <= 0 and needs_review = false;

comment on column public.kit_items.needs_review is
    'Set when the imported line cannot be used as-is (zero quantity, unparseable SKU). Shown to CHC on the mapping screen.';

-- `kit_items.product_id` had a foreign key with no ON DELETE action, so deleting
-- a product would fail outright once any kit referenced it — the same defect
-- that was fixed on replenishment_order_lines. SET NULL is the right action
-- here: the kit line survives as unresolved rather than the line vanishing.
alter table public.kit_items drop constraint if exists kit_items_product_id_fkey;
alter table public.kit_items
    add constraint kit_items_product_id_fkey
    foreign key (product_id) references public.products(id) on delete set null;

-- ------------------------------------------------------------
-- 2. Per-company resolution of a kit line
-- ------------------------------------------------------------

create table if not exists public.kit_product_map (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references public.companies(id) on delete cascade,
    kit_item_id  uuid not null references public.kit_items(id) on delete cascade,

    -- The product this line means on this company's shelf. NULL together with
    -- is_excluded = false means "not resolved yet" and blocks the consume.
    product_id   uuid references public.products(id) on delete cascade,

    -- NULL = use the kit's own quantity. Set = this shop uses a different amount.
    quantity     numeric,

    -- The shop does not use this line at all (a step they do not perform, or a
    -- material they buy elsewhere). Excluded lines are skipped, not blocking.
    is_excluded  boolean not null default false,

    note         text,
    updated_at   timestamptz not null default now(),
    updated_by   uuid references public.admin_users(id) on delete set null,

    constraint kit_product_map_unique unique (company_id, kit_item_id),
    constraint kit_product_map_qty_chk check (quantity is null or quantity > 0),
    constraint kit_product_map_resolution_chk check (
        (is_excluded = true and product_id is null) or (is_excluded = false)
    )
);

comment on table public.kit_product_map is
    'What a master kit line means for one company: which product, how much, or excluded. Resolution is stored, never inferred at run time.';

create index if not exists idx_kit_product_map_company on public.kit_product_map(company_id);
create index if not exists idx_kit_product_map_item    on public.kit_product_map(kit_item_id);
create index if not exists idx_kit_product_map_product on public.kit_product_map(product_id) where product_id is not null;

-- ------------------------------------------------------------
-- 3. The consumption header
-- ------------------------------------------------------------

create table if not exists public.kit_consumptions (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references public.companies(id) on delete cascade,
    location_id  uuid not null references public.company_locations(id) on delete cascade,
    kit_id       uuid references public.repair_kits(id) on delete set null,

    -- Denormalised deliberately. A kit can be renamed or retired years after a
    -- job was invoiced; what was expensed against RO-1234 must not change.
    kit_name     text not null,

    job_ref      text not null,
    multiplier   numeric not null default 1,

    line_count   integer not null default 0,
    total_cost   numeric not null default 0,

    actor_label  text,
    actor_type   text not null default 'store',
    created_by   uuid references public.admin_users(id) on delete set null,
    created_at   timestamptz not null default now(),

    constraint kit_consumptions_multiplier_chk check (multiplier > 0 and multiplier <= 100),
    constraint kit_consumptions_actor_chk check (actor_type in ('admin','store','system'))
);

comment on table public.kit_consumptions is
    'One kit applied to one job. The stock_movements it produced carry source_doc_type = ''kit_consume'' and source_doc_id = this row.';
comment on column public.kit_consumptions.kit_name is
    'Snapshot of the kit name at the time of consumption — history must not move when a kit is renamed.';
comment on column public.kit_consumptions.total_cost is
    'Sum of quantity x unit price at the time of consumption, for job costing.';

create index if not exists idx_kit_consumptions_company_job on public.kit_consumptions(company_id, job_ref);
create index if not exists idx_kit_consumptions_created     on public.kit_consumptions(company_id, created_at desc);

-- Lets the Usage view walk from a movement back to the kit that produced it.
create index if not exists idx_stock_movements_source_doc
    on public.stock_movements(source_doc_type, source_doc_id)
    where source_doc_id is not null;

-- ------------------------------------------------------------
-- 4. Security — identical posture to every other table here:
--    RLS on, no policy, service role only.
-- ------------------------------------------------------------

alter table public.repair_kits        enable row level security;
alter table public.kit_items          enable row level security;
alter table public.company_kit_access enable row level security;
alter table public.kit_product_map    enable row level security;
alter table public.kit_consumptions   enable row level security;

revoke all on public.kit_product_map  from anon, authenticated;
revoke all on public.kit_consumptions from anon, authenticated;

-- ------------------------------------------------------------
-- 5. Append-only, same as the ledger it feeds
--
-- A consumption header records what was expensed against a job. Editing one
-- after the fact would let the materials on an invoiced job change without
-- trace, which is exactly what the movement ledger already refuses. Correct a
-- mistake by posting the reversing movements, not by rewriting history.
-- ------------------------------------------------------------

create or replace function public.kit_consumptions_block_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    raise exception
        'kit_consumptions is append-only: post a correcting movement instead of editing consumption %', old.id
        using errcode = 'check_violation';
end;
$$;

revoke all on function public.kit_consumptions_block_update() from public, anon, authenticated;

drop trigger if exists kit_consumptions_no_update on public.kit_consumptions;
create trigger kit_consumptions_no_update
    before update on public.kit_consumptions
    for each row execute function public.kit_consumptions_block_update();
