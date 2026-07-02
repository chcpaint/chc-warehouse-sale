-- 008_branches_routing_invoices.sql
-- CHC servicing branch directory + per-location assignment, and order invoice fields.
create table if not exists public.supplier_branches (
  id uuid primary key default extensions.uuid_generate_v4(),
  name varchar not null,
  emails text[] not null default '{}',
  city varchar,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.supplier_branches enable row level security; -- service-role only

alter table public.company_locations
  add column if not exists supplier_branch_id uuid references public.supplier_branches(id) on delete set null;
create index if not exists idx_company_locations_supplier_branch on public.company_locations(supplier_branch_id);

alter table public.orders add column if not exists invoice_path text;
alter table public.orders add column if not exists invoice_filename text;
alter table public.orders add column if not exists invoice_uploaded_at timestamptz;
alter table public.orders add column if not exists invoice_uploaded_by uuid references public.admin_users(id) on delete set null;

-- private storage bucket for invoices
insert into storage.buckets (id, name, public) values ('invoices','invoices',false)
on conflict (id) do nothing;
