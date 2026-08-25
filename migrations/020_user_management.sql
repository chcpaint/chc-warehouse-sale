-- 020_user_management.sql
-- CHC staff roles + invites, per-company customer users, and order attribution.

alter table public.admin_users
  add column if not exists branch_id uuid references public.supplier_branches(id) on delete set null,
  add column if not exists invite_token varchar(128),
  add column if not exists invite_expires_at timestamptz,
  add column if not exists created_by uuid;
alter table public.admin_users alter column password_hash drop not null;
create index if not exists idx_admin_users_branch on public.admin_users(branch_id);
create index if not exists idx_admin_users_invite on public.admin_users(invite_token);

create table if not exists public.company_users (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  location_id uuid references public.company_locations(id) on delete set null,
  email varchar(255) not null,
  name varchar(255) not null,
  password_hash varchar(255),
  role varchar(32) not null default 'member',
  is_active boolean not null default true,
  invite_token varchar(128),
  invite_expires_at timestamptz,
  invited_by uuid,
  invited_by_type varchar(16),
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_company_users_email on public.company_users(company_id, lower(email));
create index if not exists idx_company_users_company on public.company_users(company_id);
create index if not exists idx_company_users_location on public.company_users(location_id);
create index if not exists idx_company_users_invite on public.company_users(invite_token);
alter table public.company_users enable row level security;

alter table public.orders
  add column if not exists placed_by_user_id uuid references public.company_users(id) on delete set null;
create index if not exists idx_orders_placed_by on public.orders(placed_by_user_id);
