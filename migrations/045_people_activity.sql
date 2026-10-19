-- 045_people_activity.sql
-- Named user groups, a sign-in log, and a frozen "who placed it" on every order,
-- so a customer can see who is ordering and who is signing in (opt-in per
-- company by the "activity" module; none of this changes anyone's ordering).
--
-- Safe to run more than once.

-- 1. Groups of people inside one customer (Painters, Estimators, Managers...).
create table if not exists public.company_user_groups (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name varchar(80) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_company_user_groups_name
  on public.company_user_groups(company_id, lower(name));
create index if not exists idx_company_user_groups_company
  on public.company_user_groups(company_id);
alter table public.company_user_groups enable row level security;

-- A person is in at most one group. Deleting a group leaves its people in place,
-- just ungrouped.
alter table public.company_users
  add column if not exists group_id uuid references public.company_user_groups(id) on delete set null;
create index if not exists idx_company_users_group on public.company_users(group_id);

-- 2. Freeze who placed an order. placed_by_user_id goes to NULL if the person's
--    account is later deleted; the name, email and group they had at the time of
--    the order must outlive that, or the history the customer wants to review
--    would silently lose its people.
alter table public.orders
  add column if not exists placed_by_name varchar(255),
  add column if not exists placed_by_email varchar(255),
  add column if not exists placed_by_group varchar(80);

-- Orders already attributed to a person get their name now, while we still can.
update public.orders o
   set placed_by_name  = u.name,
       placed_by_email = u.email
  from public.company_users u
 where o.placed_by_user_id = u.id
   and o.placed_by_name is null;

-- 3. Sign-in log. One row per attempt that reached a real account (or a real
--    company) -- success, wrong password, a deactivated account, a new password
--    being set. Never stores a password or a token.
create table if not exists public.company_user_logins (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references public.company_users(id) on delete set null,
  email varchar(255),
  name varchar(255),
  event varchar(24) not null,
  ip varchar(64),
  user_agent varchar(300),
  created_at timestamptz not null default now()
);
create index if not exists idx_company_user_logins_company
  on public.company_user_logins(company_id, created_at desc);
create index if not exists idx_company_user_logins_user
  on public.company_user_logins(user_id, created_at desc);
alter table public.company_user_logins enable row level security;
