-- ============================================================================
-- 044 — Kit variants (brand-substituted "Save As" kits) and a billing backup
-- snapshot for insurance documentation
--
-- Two additions, both requested directly: a shop that only stocks 3M/MMM
-- adhesives, not Fusor, wants the SAME kit -- same steps, same component
-- count -- billed at 3M part numbers and 3M pricing, without CHC losing the
-- original Fusor-based master kit or having to maintain the two by hand as
-- unrelated kits.
--
-- 1. KIT VARIANTS. repair_kits already distinguishes a CHC master kit
--    (company_id null) from a company's own kit (company_id set). This adds a
--    third relationship, orthogonal to that one: a master kit can be a named
--    variant of another master kit -- "Pillar Repair -- 3M/MMM" cloned from
--    "Pillar Repair -- Fusor" with its adhesive lines re-pointed at 3M part
--    numbers via the kit's own kit_item_alternatives (migration 033). The
--    parent is for provenance and admin display only; nothing resolves,
--    prices or bills through it. Each variant is offered to customers through
--    company_kit_access exactly like any other master kit -- a shop that only
--    stocks 3M is simply granted the 3M variant instead of the original, and
--    never sees the Fusor one.
--
--    ON DELETE SET NULL, not CASCADE: deleting the kit a variant was cloned
--    from must not take the variant down with it -- the variant is a complete,
--    independent kit the moment it exists, not a diff against its parent.
--
-- 2. BILLING BACKUP SNAPSHOT. kit_consumptions.total_cost already exists, but
--    the line-by-line detail behind that number was only ever reconstructable
--    by joining stock_movements back to *today's* product rows -- so a kit
--    consumed six months ago would show today's price and today's name if
--    either had since changed. That is fine for the ledger, which only ever
--    cared about the total, but it is not fine for a document handed to an
--    insurer as backup for what was billed: that document must show what the
--    shop actually charged, on the day the job was done, at the brand and
--    part number actually used. lines_snapshot is that record -- written once,
--    at consume time, from the same priced lines that produced total_cost,
--    and never touched again (kit_consumptions is already append-only, see
--    migration 016's block-update trigger, which covers this column too).
--
-- Safe to re-run.
-- ============================================================================

alter table public.repair_kits
    add column if not exists parent_kit_id uuid references public.repair_kits(id) on delete set null;

comment on column public.repair_kits.parent_kit_id is
    'Set when this master kit was cloned from another as a brand variant (e.g. a Fusor kit''s 3M/MMM equivalent). Provenance and admin display only -- resolution, pricing and billing never traverse this link.';

create index if not exists idx_repair_kits_parent on public.repair_kits(parent_kit_id) where parent_kit_id is not null;

-- A variant cannot be its own parent, and a company-owned kit (which has no
-- customer-facing siblings to relate to) never carries one.
alter table public.repair_kits drop constraint if exists repair_kits_parent_not_self_chk;
alter table public.repair_kits
    add constraint repair_kits_parent_not_self_chk check (parent_kit_id is null or parent_kit_id <> id);

alter table public.kit_consumptions
    add column if not exists lines_snapshot jsonb;

comment on column public.kit_consumptions.lines_snapshot is
    'Itemized lines as actually billed at consume time -- [{kit_sku, sku, brand, name, category, unit, quantity, unit_price, line_cost}, ...]. Denormalised deliberately, same reasoning as kit_name: a product''s price or name changing later, or a company''s kit_product_map being re-mapped later, must not change what a past job''s billing backup document shows. NULL on consumptions written before this column existed; the billing-doc endpoint falls back to stock_movements for those.';
