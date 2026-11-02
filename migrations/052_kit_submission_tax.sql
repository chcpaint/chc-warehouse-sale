-- ============================================================================
-- 052: Tax on insurance kit submissions
--
-- A kit submission is a numbered, frozen document. Its tax is frozen with it:
-- the rate that applied on the day it was generated is stored on the row, so a
-- later rate change never rewrites an old document.
--
--   subtotal_amount  materials total, before tax
--   tax_rate         the rate used, as a fraction (0.13 = 13%)
--   tax_amount       tax in dollars, rounded to the cent
--   tax_label        what to call it on the document ('HST', 'Tax', 'Tax exempt')
--   total_amount     (existing) what is billed: subtotal + tax
--
-- Rows created before this migration keep NULL here and read exactly as they
-- always did (no tax shown, total_amount unchanged). Safe to re-run.
-- Run this BEFORE deploying the code that writes these columns.
-- ============================================================================

alter table public.kit_submissions
    add column if not exists subtotal_amount numeric(12,2),
    add column if not exists tax_rate        numeric(6,4),
    add column if not exists tax_amount      numeric(12,2),
    add column if not exists tax_label       text;

comment on column public.kit_submissions.subtotal_amount is 'Materials total before tax. NULL on documents created before tax was added.';
comment on column public.kit_submissions.tax_rate        is 'Tax rate applied when generated, as a fraction (0.13 = 13%). Frozen with the document.';
comment on column public.kit_submissions.tax_amount      is 'Tax in dollars, rounded to the cent. Frozen with the document.';

-- The document stays append-only: the new columns are frozen too.
create or replace function public.kit_submissions_guard()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'DELETE' then
        -- Allowed only as part of deleting the company itself.
        if exists (select 1 from public.companies where id = old.company_id) then
            raise exception 'Kit submissions cannot be deleted; void the submission instead.';
        end if;
        return old;
    end if;

    if new.company_id      is distinct from old.company_id
    or new.submission_no   is distinct from old.submission_no
    or new.kit_name        is distinct from old.kit_name
    or new.multiplier      is distinct from old.multiplier
    or new.ro_number       is distinct from old.ro_number
    or new.claim_no        is distinct from old.claim_no
    or new.insurer         is distinct from old.insurer
    or new.vehicle         is distinct from old.vehicle
    or new.vin             is distinct from old.vin
    or new.notes           is distinct from old.notes
    or new.line_count      is distinct from old.line_count
    or new.total_amount    is distinct from old.total_amount
    or new.subtotal_amount is distinct from old.subtotal_amount
    or new.tax_rate        is distinct from old.tax_rate
    or new.tax_amount      is distinct from old.tax_amount
    or new.tax_label       is distinct from old.tax_label
    or new.lines_snapshot  is distinct from old.lines_snapshot
    or new.created_at      is distinct from old.created_at then
        raise exception 'A submitted document cannot be changed. Void it and generate a new one.';
    end if;

    new.updated_at := now();
    return new;
end;
$$;
revoke all on function public.kit_submissions_guard() from public, anon, authenticated;
