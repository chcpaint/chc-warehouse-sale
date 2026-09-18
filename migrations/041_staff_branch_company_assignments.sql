-- 041_staff_branch_company_assignments.sql
--
-- Let an order-desk account be assigned to more than one CHC branch and,
-- optionally, restricted to specific customers within them — replacing the
-- single branch_id from migration 020 as the source of truth for order
-- visibility, without breaking anything that still reads branch_id.
--
-- Both new tables are purely additive:
--   - admin_user_branches   which CHC branches this account works from.
--   - admin_user_companies  an OPTIONAL narrowing: if a row exists here,
--                           the account only sees these customers, even if
--                           its branches serve more. Empty means "every
--                           customer the assigned branches serve" — today's
--                           behaviour, unchanged.
--
-- utils/order-scope.js unions admin_users.branch_id (kept, and kept in sync
-- as this account's "primary" branch by routes/admin-users.js) with these
-- tables, so an account touched by nothing in this release loses no access.
-- See staffBranchIds / staffCompanyIds / staffLocationIds.
--
-- order_manager is deliberately untouched: it sees every branch and every
-- customer by role, same as before this migration and before migration 025
-- that introduced it — a picker would only imply a limit that isn't real.

create table if not exists public.admin_user_branches (
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  branch_id uuid not null references public.supplier_branches(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (admin_user_id, branch_id)
);
create index if not exists idx_admin_user_branches_branch on public.admin_user_branches(branch_id);
alter table public.admin_user_branches enable row level security; -- service-role only

create table if not exists public.admin_user_companies (
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (admin_user_id, company_id)
);
create index if not exists idx_admin_user_companies_company on public.admin_user_companies(company_id);
alter table public.admin_user_companies enable row level security; -- service-role only

-- Backfill: every account's existing single branch becomes its first row in
-- the new table, so this ships with nobody's access changed. (Nothing to
-- backfill into admin_user_companies -- no such narrowing existed before.)
insert into public.admin_user_branches (admin_user_id, branch_id)
select id, branch_id from public.admin_users
where branch_id is not null
on conflict (admin_user_id, branch_id) do nothing;
