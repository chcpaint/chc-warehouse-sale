-- 021_item_library.sql
--
-- The Item Library: every SKU CHC's suppliers have ever listed, in one place.
--
-- WHY THIS IS NOT A PRODUCT TABLE
--
-- products is per company. Two shops that both stock 3M 06652 are two rows, in
-- two catalogues, at two different prices — that is the whole point of the
-- tenant model and it is not going to change. This table is the opposite: one
-- row per part, no company, no price that anyone is charged. It exists so a
-- person adding an item to a shop can look up the real part number, description
-- and barcode instead of typing one from memory.
--
-- WHY IT IS CALLED A LIBRARY AND NOT "OLD INVENTORY"
--
-- The August 2026 master file carries no expiry signal at all: is_active and
-- super_by are empty on every row, and every date in it is 2026. Nothing in the
-- data distinguishes a discontinued part from a current one. Naming the table
-- after staleness would assert something the file cannot support, and sooner or
-- later somebody would skip a live part because the screen implied it was dead.
-- "Library" claims only what is true: these are known items, look them up.
--
-- WHY sku_key
--
-- The same part is written MMM-06652, MMM06652 and mmm 06652 depending on who
-- typed it. sku_key is the SKU with case and punctuation removed, and it is the
-- unique key, so the library physically cannot hold the same part twice under
-- two spellings. Every lookup — here, in the search function, and in the route
-- that adds to a catalogue — normalises the same way, so they can never
-- disagree about whether two SKUs are the same item.
--
-- RLS is enabled with no policy, which is the deny-all backstop used across
-- this schema: nothing reaches this table except through the service role, and
-- the application decides who may look.

create table if not exists public.item_library (
    id           uuid primary key default gen_random_uuid(),
    sku          text not null,
    sku_key      text not null,
    name         text not null,
    brand        text,
    vendor_code  text,
    barcode      text,
    unit         text,
    case_qty     numeric,
    list_price   numeric,
    source       text not null default 'master_import',
    source_ref   text,
    imported_at  timestamptz not null default now(),
    notes        text,
    constraint item_library_sku_key_unique unique (sku_key)
);

comment on table public.item_library is
    'Supplier master catalogue. Reference only — nothing here is on sale to anyone until it is added to a company catalogue.';
comment on column public.item_library.list_price is
    'What the supplier listed. A suggestion shown to whoever adds the item, never a price applied to a shop.';
comment on column public.item_library.sku_key is
    'SKU with case and punctuation stripped. The unique key, so one part cannot appear twice under two spellings.';

create index if not exists idx_item_library_vendor
    on public.item_library (vendor_code);

create index if not exists idx_item_library_barcode
    on public.item_library (barcode) where barcode is not null;

create index if not exists idx_item_library_search
    on public.item_library
    using gin (to_tsvector('simple', coalesce(sku, '') || ' ' || coalesce(name, '')));

alter table public.item_library enable row level security;
revoke all on public.item_library from anon, authenticated;
